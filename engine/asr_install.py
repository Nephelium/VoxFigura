"""Install the optional offline recognizer inside the project cache."""
from __future__ import annotations

from hashlib import file_digest
from http.client import HTTPException
from importlib import invalidate_caches
from importlib.metadata import distributions
from importlib.util import find_spec
import os
from pathlib import Path
from shutil import disk_usage
import subprocess
import sys
from tempfile import TemporaryDirectory
from threading import Lock, Thread
from time import monotonic
from typing import Callable
from urllib.request import urlopen

from asr_models import CACHE, DEFAULT_MODEL, MODELS, model_dir

RUNTIME = CACHE / "python"
HUGGING_FACE = "https://huggingface.co"
HF_MIRROR = "https://hf-mirror.com"
REGION_LOOKUP = "https://www.cloudflare.com/cdn-cgi/trace"
PACKAGES = {"faster-whisper": "1.2.1", "ctranslate2": "4.6.0", "av": "15.1.0"}


def add_runtime_path() -> None:
    if RUNTIME.is_dir() and str(RUNTIME) not in sys.path:
        sys.path.append(str(RUNTIME))
        invalidate_caches()


def _verify(path: Path, size: int, expected: str) -> bool:
    if not path.is_file() or path.stat().st_size != size:
        return False
    with path.open("rb") as stream:
        return file_digest(stream, "sha256").hexdigest() == expected


def _download_sources() -> tuple[str, ...]:
    override = os.environ.get("VOCALCUT_ASR_DOWNLOAD_HOST", "").strip().rstrip("/")
    if override:
        return (override,)
    try:
        with urlopen(REGION_LOOKUP, timeout=4) as response:
            mainland = "loc=CN" in response.read(4096).decode("utf-8").splitlines()
    except (HTTPException, OSError, ValueError):
        mainland = False
    return (HF_MIRROR, HUGGING_FACE) if mainland else (HUGGING_FACE, HF_MIRROR)


def _setup_runtime() -> None:
    installed = {item.metadata["Name"].lower().replace("_", "-"): item.version for item in distributions(path=[str(RUNTIME)])}
    needed = [f"{package}=={version}" for package, version in PACKAGES.items() if installed.get(package) != version]
    add_runtime_path()
    supporting_modules = ("huggingface_hub", "tokenizers", "onnxruntime", "tqdm", "yaml")
    has_dependencies = all(find_spec(name) is not None for name in supporting_modules)
    if needed or not has_dependencies:
        if not has_dependencies:
            needed = [f"{package}=={version}" for package, version in PACKAGES.items()]
        subprocess.run(
            [sys.executable, "-B", "-m", "pip", "--disable-pip-version-check", "install",
             "--no-cache-dir", "--no-compile", "--only-binary=:all:", "--upgrade",
             "--target", str(RUNTIME), *(["--no-deps"] if has_dependencies else []), *needed],
            check=True, timeout=240,
        )
        add_runtime_path()
        invalidate_caches()

    import faster_whisper  # noqa: F401
    import onnxruntime  # noqa: F401


def _fetch_file(url: str, target: Path, max_bytes: int, progress: Callable[[int], None]) -> None:
    deadline = monotonic() + 7200
    total = 0
    with urlopen(url, timeout=18) as response, target.open("wb") as stream:
        while chunk := response.read(256 * 1024):
            total += len(chunk)
            if total > max_bytes or monotonic() > deadline:
                raise ValueError("Model file exceeds size or time limit")
            stream.write(chunk)
            progress(total)


def _setup_model(model: str, report: Callable[[str], None]) -> None:
    spec = MODELS[model]
    destination = model_dir(model)
    destination.mkdir(parents=True, exist_ok=True)
    missing = {name: meta for name, meta in spec.files.items() if not _verify(destination / name, *meta)}
    if not missing:
        return
    download_bytes = sum(size for size, _ in missing.values())
    if disk_usage(CACHE).free < download_bytes:
        raise RuntimeError("项目磁盘空间不足，无法下载所选 Whisper 模型")
    report("正在根据公网出口地区选择下载源…")
    sources = _download_sources()
    labels = {HUGGING_FACE: "Hugging Face", HF_MIRROR: "国内 HF 镜像"}
    with TemporaryDirectory(prefix="download-", dir=CACHE) as scratch:
        for host in sources:
            description = f"正在从 {labels.get(host, '指定下载源')} 下载 Whisper {model}"
            last_percent = -1
            completed_bytes = 0

            def progress(file_bytes: int) -> None:
                nonlocal last_percent
                percent = min(99, (completed_bytes + file_bytes) * 100 // download_bytes)
                if percent != last_percent:
                    last_percent = percent
                    report(f"{description} · {percent}%")

            progress(0)
            base_url = f"{host}/{spec.repository}/resolve/{spec.revision}"
            try:
                for name, (size, digest) in missing.items():
                    pending = Path(scratch) / name
                    if not _verify(pending, size, digest):
                        _fetch_file(f"{base_url}/{name}", pending, size, progress)
                        if not _verify(pending, size, digest):
                            raise ValueError("Model file failed SHA-256 verification")
                    completed_bytes += size
            except (HTTPException, OSError, ValueError):
                continue
            for name in missing:
                (Path(scratch) / name).replace(destination / name)
            return
    raise RuntimeError(f"Whisper {model} 下载或校验未完成，请检查网络后重试")


def setup_asr(model: str = DEFAULT_MODEL, report: Callable[[str], None] = print) -> None:
    report("正在准备本地语音识别运行库…")
    try:
        _setup_runtime()
    except (ImportError, OSError, RuntimeError, subprocess.SubprocessError) as error:
        raise RuntimeError("本地语音识别运行库安装失败，请检查 Python 环境和网络后重试") from error
    if model in MODELS and not os.environ.get("VOCALCUT_ASR_MODEL_DIR"):
        _setup_model(model, report)


class AsrInstallJob:
    def __init__(self) -> None:
        self._lock = Lock()
        self._status: dict[str, str] = {}

    def status(self) -> dict[str, str]:
        with self._lock:
            return self._status.copy()

    def start(self, model: str) -> dict[str, str]:
        with self._lock:
            if self._status.get("state") != "installing":
                self._status = {"state": "installing", "model": model, "hint": "正在准备下载 Whisper…"}
                Thread(target=self._run, args=(model,), name="whisper-install", daemon=True).start()
            return self._status.copy()

    def _report(self, hint: str) -> None:
        with self._lock:
            self._status["hint"] = hint

    def _run(self, model: str) -> None:
        try:
            setup_asr(model, self._report)
            result = {}
        except RuntimeError as error:
            result = {"state": "failed", "hint": str(error)}
        except (OSError, ValueError):
            result = {"state": "failed", "hint": "无法写入本地识别缓存，请检查项目目录权限和剩余空间"}
        except Exception:
            result = {"state": "failed", "hint": "本地 Whisper 安装意外中断，请重试"}
        with self._lock:
            self._status = {"model": model, **result} if result else {}
