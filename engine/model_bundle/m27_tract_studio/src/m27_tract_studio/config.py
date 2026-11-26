"""Configuration, path discovery, and checkpoint inspection for m27-tract-studio."""
from __future__ import annotations

from dataclasses import dataclass, field
import os
from pathlib import Path
import sys
from typing import Any, Dict, List, Optional, Tuple

DEFAULT_TRAIN_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_PTB_ROOT = DEFAULT_TRAIN_ROOT / "ptb"

CHECKPOINT_CATALOG: Tuple[Dict[str, str], ...] = (
    {
        "id": "neural_best",
        "official_name": "Tract2Vox-Large",
        "label": "Tract2Vox-Large · 最优神经赋声 (配 Vox2Tract-Large 声道反演)",
        "kind": "neural",
    },
    {
        "id": "neural_latest",
        "official_name": "Tract2Vox-Large",
        "label": "Tract2Vox-Large · 末步神经赋声 (latest + 声道反演)",
        "kind": "neural",
    },
    {
        "id": "neural_v2_archive",
        "official_name": "Tract2Vox-Large-v2",
        "label": "Tract2Vox-Large-v2 · 基础 NSF 归档 (#10000 对比)",
        "kind": "neural",
    },
    {
        "id": "neural_v1_archive",
        "official_name": "Tract2Vox-Large-v1",
        "label": "Tract2Vox-Large-v1 · 纯 HiFi-GAN 归档 (#6000 对比)",
        "kind": "neural",
    },
    {
        "id": "motor_natural",
        "official_name": "Vox2Tract-Large",
        "label": "Vox2Tract-Large · 声道反演最优 (#26500 VTL 物理合成)",
        "kind": "vtl",
    },
    {
        "id": "motor_natural_latest",
        "official_name": "Vox2Tract-Large",
        "label": "Vox2Tract-Large · 声道反演末步 (#32000 VTL 物理合成)",
        "kind": "vtl",
    },
    {
        "id": "motor_glottis",
        "official_name": "Stage3B-Glottis-Stopped",
        "label": "Stage 3B · 声门专精实验档 (VTL 物理对照)",
        "kind": "vtl",
    },
    {
        "id": "motor_synth",
        "official_name": "Stage3A-Motor-Synth",
        "label": "Stage 3A · 合成联合训练基线 (VTL 物理对照)",
        "kind": "vtl",
    },
)

CHECKPOINT_ALIASES: Dict[str, str] = {
    "tract2vox": "neural_best",
    "tract2vox-large": "neural_best",
    "tract2vox_large": "neural_best",
    "tract2vox-large-latest": "neural_latest",
    "tract2vox_large_latest": "neural_latest",
    "tract2vox-large-v2": "neural_v2_archive",
    "tract2vox_large_v2": "neural_v2_archive",
    "tract2vox-large-v1": "neural_v1_archive",
    "tract2vox_large_v1": "neural_v1_archive",
    "vox2tract": "motor_natural",
    "vox2tract-large": "motor_natural",
    "vox2tract_large": "motor_natural",
    "vox2tract-large-latest": "motor_natural_latest",
    "vox2tract_large_latest": "motor_natural_latest",
}


def resolve_checkpoint_alias(pref: str) -> str:
    raw = str(pref or "").strip()
    return CHECKPOINT_ALIASES.get(raw.lower(), raw)


VALID_CHECKPOINTS: Tuple[str, ...] = (
    ("auto", "neural_synth")
    + tuple(item["id"] for item in CHECKPOINT_CATALOG)
    + tuple(CHECKPOINT_ALIASES.keys())
)


def _detect_pkg_root() -> Path:
    return Path(__file__).resolve().parent.parent.parent


def find_web_dir(pkg_root: Optional[Path] = None) -> Path:
    """Locate static web UI assets across editable/copied source and wheel installs."""
    root = pkg_root or _detect_pkg_root()
    candidates = [
        root / "web",
        Path(sys.prefix) / "share" / "m27_tract_studio" / "web",
        Path(__file__).resolve().parent / "web",
    ]
    for cand in candidates:
        if (cand / "tract-studio.js").is_file() and (cand / "theme.css").is_file():
            return cand.resolve()
    return (root / "web").resolve()


def _detect_train_root(pkg_root: Path) -> Path:
    env_val = os.environ.get("M27_TRACT_TRAIN_ROOT", "").strip()
    if env_val:
        return Path(env_val)
    for anc in (pkg_root.parent, pkg_root, Path.cwd()):
        if (anc / "src" / "tt3").is_dir() and (anc / "runs").is_dir():
            return anc
    return DEFAULT_TRAIN_ROOT


@dataclass
class TractStudioConfig:
    """Runtime paths and inference defaults for M27 dynamic vocal-tract reconstruction."""

    train_root: Path = field(default_factory=lambda: _detect_train_root(_detect_pkg_root()))
    run_root: Optional[Path] = None
    work_dir: Optional[Path] = None
    hf_cache_dir: Optional[Path] = None
    ptb_root: Optional[Path] = None
    default_device: str = "cpu"
    default_checkpoint: str = "neural_best"
    max_upload_bytes: int = 50 * 1024 * 1024
    max_duration_sec: float = 120.0
    max_chunk_sec: float = 10.0
    tube_hz: int = 100

    def __post_init__(self) -> None:
        self.train_root = Path(self.train_root).resolve()

        env_run = os.environ.get("M27_TRACT_RUN_ROOT", "").strip()
        if self.run_root is not None:
            self.run_root = Path(self.run_root).resolve()
        elif env_run:
            self.run_root = Path(env_run).resolve()
        else:
            self.run_root = (self.train_root / "runs" / "m27_v1").resolve()

        env_work = os.environ.get("M27_TRACT_WORK_DIR", "").strip()
        if self.work_dir is not None:
            self.work_dir = Path(self.work_dir).resolve()
        elif env_work:
            self.work_dir = Path(env_work).resolve()
        else:
            legacy_dir = self.run_root / "web_infer"
            if legacy_dir.is_dir():
                self.work_dir = legacy_dir.resolve()
            else:
                self.work_dir = (_detect_pkg_root() / "workspace" / "jobs").resolve()

        env_hf = os.environ.get("M27_TRACT_HF_CACHE", "").strip()
        if self.hf_cache_dir is not None:
            self.hf_cache_dir = Path(self.hf_cache_dir).resolve()
        elif env_hf:
            self.hf_cache_dir = Path(env_hf).resolve()
        else:
            self.hf_cache_dir = (self.train_root / "cache" / "hf").resolve()

        env_ptb = os.environ.get("M27_TRACT_PTB_ROOT", "").strip()
        if self.ptb_root is not None:
            self.ptb_root = Path(self.ptb_root).resolve()
        elif env_ptb:
            self.ptb_root = Path(env_ptb).resolve()
        else:
            self.ptb_root = DEFAULT_PTB_ROOT.resolve()


def ensure_runtime_paths(cfg: TractStudioConfig) -> None:
    """Bind read-only TT3 and PhoneticToolbox phonetic_core sources onto sys.path."""
    os.environ.setdefault("HF_HOME", str(cfg.hf_cache_dir))
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

    for p in (
        cfg.train_root / "src",
        cfg.ptb_root / "packages" / "phonetic_core" / "src",
    ):
        s = str(p)
        if p.is_dir() and s not in sys.path:
            sys.path.insert(0, s)

    # Apply explicit overrides to tt3 module globals if present (strictly in-memory).
    try:
        from tt3 import constants as tt3_const
        from tt3 import pitch as tt3_pitch
        from tt3 import tract_anim as tt3_anim

        vtl_dir = cfg.ptb_root / "resources" / "vocal_tract" / "native"
        f0_onnx = cfg.ptb_root / "resources" / "neural" / "swift-f0-0.3.0.onnx"
        tt3_const.TRAIN_ROOT = cfg.train_root
        tt3_const.HF_CACHE_DIR = cfg.hf_cache_dir
        if vtl_dir.is_dir():
            tt3_const.VTL_NATIVE_DIR = vtl_dir
            tt3_anim.VTL_NATIVE_DIR = vtl_dir
        if f0_onnx.is_file():
            tt3_const.SWIFTF0_ONNX = f0_onnx
            tt3_pitch.SWIFTF0_ONNX = f0_onnx
    except Exception:
        pass


def pick_motor_checkpoint(run_root: Path, pref: str) -> Tuple[str, Path]:
    """Select the Stage 3/4 articulatory motor checkpoint for a given UI preference."""
    pref = resolve_checkpoint_alias(pref)
    if pref in (
        "auto",
        "neural_synth",
        "neural_latest",
        "neural_best",
        "neural_v2_archive",
        "neural_v1_archive",
    ):
        order = (
            ("motor_natural", "best.pt"),
            ("motor_natural", "latest.pt"),
            ("motor_glottis", "best.pt"),
            ("motor_glottis", "latest.pt"),
            ("motor_synth", "best.pt"),
            ("motor_synth", "latest.pt"),
        )
    elif pref == "motor_natural_latest":
        order = (("motor_natural", "latest.pt"), ("motor_natural", "best.pt"))
    else:
        order = ((pref, "best.pt"), (pref, "latest.pt"))

    for stage, fname in order:
        cand = run_root / stage / fname
        if cand.is_file():
            return stage, cand
    raise FileNotFoundError(f"未找到可用 Vox2Tract / M27 声道反演检查点 ({pref}) 于 {run_root}")


def pick_neural_checkpoint_path(run_root: Path, pref: str = "neural_best") -> Path:
    """Resolve Stage 5 neural synthesizer checkpoint file path without loading weights."""
    pref = resolve_checkpoint_alias(pref)
    if pref in ("neural_v1_archive", "neural_v2_archive"):
        sub = "neural_synth_hifi_v1_archive" if pref == "neural_v1_archive" else "neural_synth_nsf_v2_archive"
        ns_dir = run_root / sub
        for fname in ("best.pt", "latest.pt"):
            p = ns_dir / fname
            if p.is_file():
                return p
        raise FileNotFoundError(f"未找到归档 Stage 5 检查点于 {ns_dir}")

    ns_dir = run_root / "neural_synth"
    best_p = ns_dir / "best.pt"
    latest_p = ns_dir / "latest.pt"
    if pref == "neural_latest":
        for p in (latest_p, best_p):
            if p.is_file():
                return p
        raise FileNotFoundError(f"未找到 Stage 5 检查点于 {ns_dir}")
    if pref in ("neural_best", "neural_synth", "auto"):
        for p in (best_p, latest_p):
            if p.is_file():
                return p
        raise FileNotFoundError(f"未找到 Stage 5 检查点于 {ns_dir}")
    raise FileNotFoundError(f"未知的 Stage 5 检查点选项: {pref}")


def inspect_available_checkpoints(run_root: Path) -> List[Dict[str, Any]]:
    """Return UI checkpoint options annotated with availability on disk."""
    out: List[Dict[str, Any]] = []
    for item in CHECKPOINT_CATALOG:
        cid = item["id"]
        available = False
        file_name = ""
        try:
            if item["kind"] == "neural":
                # Needs both motor checkpoint and stage 5 checkpoint
                pick_motor_checkpoint(run_root, cid)
                np_path = pick_neural_checkpoint_path(run_root, cid)
                available = np_path.is_file()
                file_name = f"{np_path.parent.name}/{np_path.name}"
            else:
                st, mp = pick_motor_checkpoint(run_root, cid)
                available = mp.is_file()
                file_name = f"{st}/{mp.name}"
        except FileNotFoundError:
            available = False
        out.append(
            {
                "id": cid,
                "official_name": item.get("official_name", cid),
                "label": item["label"],
                "kind": item["kind"],
                "available": available,
                "file": file_name,
            }
        )
    return out
