"""On-demand downloader for SenseVoice-Small ONNX weights with IP-based mirror switching."""
from __future__ import annotations

from dataclasses import dataclass
from hashlib import file_digest
from http.client import HTTPException
from importlib.util import find_spec
import os
from pathlib import Path
from shutil import disk_usage, rmtree
from tempfile import TemporaryDirectory
from threading import Lock, Thread
from time import monotonic
from typing import Any, Callable
from urllib.request import Request, urlopen

import asr_models
from asr_models import DEFAULT_MODEL, MODELS, ModelFiles, cache_root, model_dir

HUGGING_FACE = "https://huggingface.co"
HF_MIRROR = "https://hf-mirror.com"
MODELSCOPE = "https://www.modelscope.cn"
REGION_LOOKUP = "https://www.cloudflare.com/cdn-cgi/trace"
USER_AGENT = "VoxFigura/1.0 (+https://github.com/k2-fsa/sherpa-onnx)"


@dataclass(frozen=True)
class DownloadSource:
    id: str
    label: str
    kind: str  # "hf" | "modelscope"
    host: str

    def file_url(self, spec: ModelFiles, filename: str) -> str:
        if self.kind == "modelscope":
            return f"{self.host}/models/{spec.modelscope_repository}/resolve/master/{filename}"
        return f"{self.host}/{spec.repository}/resolve/{spec.revision}/{filename}"


def _verify(path: Path, size: int, expected: str) -> bool:
    if not path.is_file() or path.stat().st_size != size:
        return False
    with path.open("rb") as stream:
        return file_digest(stream, "sha256").hexdigest() == expected


def _detect_region() -> str:
    try:
        req = Request(REGION_LOOKUP, headers={"User-Agent": USER_AGENT})
        with urlopen(req, timeout=4) as response:
            lines = response.read(4096).decode("utf-8", errors="ignore").splitlines()
            if "loc=CN" in lines:
                return "cn"
            return "global"
    except (HTTPException, OSError, ValueError):
        return "global"


def _download_sources() -> tuple[str, tuple[DownloadSource, ...]]:
    override = os.environ.get("VOCALCUT_ASR_DOWNLOAD_HOST", "").strip().rstrip("/")
    if override:
        kind = "modelscope" if "modelscope.cn" in override.lower() else "hf"
        return ("custom", (DownloadSource("custom", "指定下载源", kind, override),))

    region = _detect_region()
    hf_mirror = DownloadSource("hf_mirror", "国内 HF 镜像 (hf-mirror)", "hf", HF_MIRROR)
    modelscope = DownloadSource("modelscope", "ModelScope 魔搭社区", "modelscope", MODELSCOPE)
    huggingface = DownloadSource("huggingface", "Hugging Face", "hf", HUGGING_FACE)
    if region == "cn":
        return ("cn", (hf_mirror, modelscope, huggingface))
    return ("global", (huggingface, hf_mirror, modelscope))


def _check_onnx_runtime() -> None:
    if find_spec("onnxruntime") is None or find_spec("numpy") is None:
        raise RuntimeError("本地 ONNX 推理运行库缺失，请检查应用运行环境")


def _fetch_file(url: str, target: Path, max_bytes: int, progress: Callable[[int], None]) -> None:
    deadline = monotonic() + 7200
    total = 0
    req = Request(url, headers={"User-Agent": USER_AGENT})
    with urlopen(req, timeout=20) as response, target.open("wb") as stream:
        while chunk := response.read(256 * 1024):
            total += len(chunk)
            if total > max_bytes or monotonic() > deadline:
                raise ValueError("Model file exceeds size or time limit")
            stream.write(chunk)
            progress(total)


def _setup_model(model: str, report: Callable[[dict[str, Any]], None]) -> None:
    spec = MODELS[model]
    root = cache_root()
    root.mkdir(parents=True, exist_ok=True)
    destination = model_dir(model)
    destination.mkdir(parents=True, exist_ok=True)
    missing = {name: meta for name, meta in spec.files.items() if not _verify(destination / name, *meta)}
    if not missing:
        report({
            "hint": "SenseVoice-Small 已就绪",
            "progress": 100,
            "downloaded_bytes": spec.size_bytes,
            "total_bytes": spec.size_bytes,
        })
        return

    download_bytes = sum(size for size, _ in missing.values())
    if disk_usage(root).free < download_bytes + 32 * 1024 * 1024:
        raise RuntimeError("磁盘可用空间不足，无法下载 SenseVoice-Small 模型（需要约 260 MB 空间）")

    report({
        "hint": "正在根据网络地区自动选择下载源…",
        "progress": 0,
        "downloaded_bytes": 0,
        "total_bytes": download_bytes,
    })
    region, sources = _download_sources()
    with TemporaryDirectory(prefix="download-", dir=root) as scratch:
        for source in sources:
            last_percent = -1
            completed_bytes = 0

            def on_progress(file_bytes: int) -> None:
                nonlocal last_percent
                done = completed_bytes + file_bytes
                percent = min(99, int(done * 100 // max(1, download_bytes)))
                if percent != last_percent or done == 0:
                    last_percent = percent
                    report({
                        "hint": f"正在从 {source.label} 下载 SenseVoice-Small · {percent}%",
                        "progress": percent,
                        "downloaded_bytes": done,
                        "total_bytes": download_bytes,
                        "source": source.label,
                        "region": region,
                    })

            on_progress(0)
            try:
                for name, (size, digest) in missing.items():
                    pending = Path(scratch) / name
                    if not _verify(pending, size, digest):
                        _fetch_file(source.file_url(spec, name), pending, size, on_progress)
                        if not _verify(pending, size, digest):
                            raise ValueError("Model file failed SHA-256 verification")
                    completed_bytes += size
                    on_progress(0)
            except (HTTPException, OSError, ValueError):
                continue

            report({
                "hint": "下载完成，正在校验并安装 SenseVoice-Small…",
                "progress": 99,
                "downloaded_bytes": download_bytes,
                "total_bytes": download_bytes,
                "source": source.label,
                "region": region,
            })
            for name in missing:
                (Path(scratch) / name).replace(destination / name)
            report({
                "hint": "SenseVoice-Small 已安装就绪",
                "progress": 100,
                "downloaded_bytes": download_bytes,
                "total_bytes": download_bytes,
                "source": source.label,
                "region": region,
            })
            return

    raise RuntimeError("SenseVoice-Small 下载或校验未完成，请检查网络连接后重试")


def remove_model(model: str = DEFAULT_MODEL) -> bool:
    if model not in MODELS:
        return False
    target = model_dir(model)
    if target.is_dir():
        rmtree(target, ignore_errors=False)
        return True
    return False


def setup_asr(model: str = DEFAULT_MODEL, report: Callable[[Any], None] = print) -> None:
    def emit(payload: dict[str, Any]) -> None:
        if report is print:
            print(payload.get("hint", ""))
        else:
            report(payload)

    _check_onnx_runtime()
    if model in MODELS and not os.environ.get("VOCALCUT_ASR_MODEL_DIR"):
        _setup_model(model, emit)


class AsrInstallJob:
    def __init__(self) -> None:
        self._lock = Lock()
        self._status: dict[str, Any] = {}

    def status(self) -> dict[str, Any]:
        with self._lock:
            return self._status.copy()

    def start(self, model: str = DEFAULT_MODEL) -> dict[str, Any]:
        with self._lock:
            if self._status.get("state") != "installing":
                total = MODELS[model].size_bytes if model in MODELS else 0
                self._status = {
                    "state": "installing",
                    "model": model,
                    "hint": "正在准备下载 SenseVoice-Small…",
                    "progress": 0,
                    "downloaded_bytes": 0,
                    "total_bytes": total,
                }
                Thread(target=self._run, args=(model,), name="sensevoice-install", daemon=True).start()
            return self._status.copy()

    def _report(self, update: dict[str, Any] | str) -> None:
        with self._lock:
            if isinstance(update, str):
                self._status["hint"] = update
            else:
                self._status.update(update)

    def _run(self, model: str) -> None:
        try:
            setup_asr(model, self._report)
            result: dict[str, Any] = {}
        except RuntimeError as error:
            result = {"state": "failed", "hint": str(error)}
        except (OSError, ValueError):
            result = {"state": "failed", "hint": "无法写入本地模型缓存，请检查目录权限与磁盘剩余空间"}
        except Exception:
            result = {"state": "failed", "hint": "SenseVoice-Small 下载意外中断，请重试"}
        with self._lock:
            self._status = {"model": model, **result} if result else {}


# Keep module alias accessible for tests patching cache root
CACHE = asr_models.DEFAULT_CACHE
