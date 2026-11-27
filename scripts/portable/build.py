"""Assemble the Windows x64 CPU portable bundle from reviewed inputs."""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from hashlib import file_digest
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import struct
import subprocess
import sys
import sysconfig
import tempfile
from urllib.request import urlopen
from zipfile import ZipFile


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = Path(__file__).resolve().parent
OUTPUT = ROOT / "build" / "portable"
DOWNLOADS = ROOT / "build" / "portable-inputs"
ENGINE_FILES = """
asr_install asr_models audio_transitions chunked_synthesis dense_channel dpdf_audio
high_pitch_preview ipa_articulation ipa_glottis_movie ipa_library_bundle ipa_materials
ipa_recording_edits ipa_reference_library ipa_reference_trajectory keyframe_lite m27_bridge
model_registry_runtime onnx_frontends onnx_inference prosody_bridge realtime_m27 server
speech_to_text swift_pitch trills validation voice_morph_bridge voqs_creak voqs_reference vowel_response
""".split()
MODEL_FILES = """
models/manifest.json
models/Vox2Tract-Lite/vox2tract_lite.onnx
models/IPA2Tract-Lite/ipa2tract_lite.onnx
models/IPA2Tract-Lite/canonical_ipa_poses_narrow.json
models/IPA2Tract-Lite/tract2area_proxy.onnx
models/Tract2Vox-Lite/tract2vox_lite.onnx
models/Vox2Spk-Lite/vox2spk_lite.onnx
models/Text2Prosody-Lite/text2prosody_lite.onnx
speakers/jingjing-lecture.spk.json
speakers/jingjing.spk.json
""".split()
MODEL_FILE_OVERRIDES = {
    "models/Vox2Tract-Lite/vox2tract_lite.onnx": ".cache/custom-models/batch2_v4/vox2tract_align_v4_flywheel_fp16s.onnx",
    "models/IPA2Tract-Lite/ipa2tract_lite.onnx": ".cache/custom-models/batch2_v4/ipa2tract_lite_v4_32d_fp16s.onnx",
    "models/IPA2Tract-Lite/canonical_ipa_poses_narrow.json": ".cache/custom-models/batch2_v4/canonical_ipa_poses_narrow.json",
    "models/Tract2Vox-Lite/tract2vox_lite.onnx": ".cache/custom-models/batch2_v4/tract2vox_lite_v3_web_fp16s.onnx",
    "models/Vox2Spk-Lite/vox2spk_lite.onnx": ".cache/custom-models/batch2_v4/vox2spk_v2_1_web_fp16s.onnx",
    "models/Text2Prosody-Lite/text2prosody_lite.onnx": ".cache/custom-models/batch2_v4/text2prosody_lite_v4_32d_fp16s.onnx",
}
OFFICIAL_ONNX_SLOTS = frozenset({
    "engine/model_bundle/models/Vox2Tract-Lite/vox2tract_lite.onnx",
    "engine/model_bundle/models/IPA2Tract-Lite/ipa2tract_lite.onnx",
    "engine/model_bundle/models/IPA2Tract-Lite/tract2area_proxy.onnx",
    "engine/model_bundle/models/Tract2Vox-Lite/tract2vox_lite.onnx",
    "engine/model_bundle/models/Vox2Spk-Lite/vox2spk_lite.onnx",
    "engine/model_bundle/models/Text2Prosody-Lite/text2prosody_lite.onnx",
    "engine/model_bundle/ptb/resources/neural/dpdfnet2_48khz_hr.onnx",
    "engine/model_bundle/ptb/resources/neural/swift-f0-0.3.0.onnx",
})
ALLOWED_SERVER_FILES = frozenset({
    "server/card-encoding.mjs",
    "server/portable.mjs",
    "server/portable-cache.mjs",
    "server/proxy.mjs",
    "server/studio-encoding.mjs",
})
FORBIDDEN_CONTEST_SERVER_FILES = frozenset({
    "server/contest-routes.mjs",
    "server/repo-knowledge.mjs",
    "server/zhihu-cli.mjs",
    "server/zhihu-author-defaults.mjs",
})
SDK_MODULES = {
    "src/tt3": "__init__ constants glottis27_generator mandarin_unt_ipa model_registry tract_anim",
    "packages/kf_ipa_synth/kf_ipa_synth":
        "__init__ baseline m27_contract phonetics pose_bank schema text2ipa tract_backend",
    "m27_voice_morph/src/m27_voice_morph": "__init__ alignment curves morpher presets",
    "ptb/packages/phonetic_core/src/phonetic_core/acoustic": "neural",
}
PRIVATE_PATH = re.compile(
    r"(?:^|/)(?:\.env[^/]*|\.git|node_modules|__pycache__|"
    r"\.zhihu-author-defaults\.local\.json|local-model-registry\.json|\.cache|"
    r"direct_url\.json|"
    r"faster_whisper(?:-[^/]*)?|ctranslate2(?:-[^/]*)?|av(?:\.libs|-[^/]*)?|"
    r"pyopenjtalk(?:-[^/]*)?|"
    r"huggingface_hub(?:-[^/]*)?|tokenizers(?:-[^/]*)?|"
    r"torch(?:-[^/]*)?|onnxruntime_gpu(?:-[^/]*)?|nvidia(?:-[^/]*)?|"
    r"triton(?:-[^/]*)?|whisper(?:-[^/]*)?)(?:/|$)"
    r"|\.(?:pt|pth|ckpt|safetensors|bin|onnx_data|key|pfx|pdb|pyc|map)$"
    r"|(?:^|/)(?:c10|torch_cpu|DirectML|cu(?:da|dnn|blas|fft|rtc)[^/]*|"
    r"nvrtc[^/]*|onnxruntime_providers_(?:cuda|tensorrt))\.dll$",
    re.IGNORECASE,
)
LOCAL_PATH_LEAK_RE = re.compile(
    r"(?:file:///+[A-Za-z]:/(?:Users|Documents)|[A-Za-z]:[/\\]Users[/\\][^/\\\s\"']+)",
    re.IGNORECASE,
)


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return file_digest(stream, "sha256").hexdigest()


def json_file(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def save_json(path: Path, value) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def classify_bundle_size_category(rel_path: str) -> str:
    """Classify a staged bundle path into AGENTS.md §4.4 size-reporting buckets."""
    p = rel_path.replace("\\", "/")
    if p.startswith("public/"):
        return "web"
    if p.startswith(("runtime/media/",)) or p in ("server/card-encoding.mjs", "server/studio-encoding.mjs"):
        return "media_encoding"
    if (
        p.endswith(".onnx")
        or p.startswith(("engine/model_bundle/models/", "engine/model_bundle/ptb/resources/neural/", "engine/model_bundle/speakers/"))
    ):
        return "models"
    if p.startswith(("engine/reference_library/",)) or p == "src/data/voqs-recordings.json":
        return "reference_library"
    if (
        p.startswith("engine/vtl_native/")
        or p.startswith("runtime/python/site-packages/onnxruntime")
        or (p.startswith("runtime/python/") and p.lower().endswith(".dll"))
    ):
        return "native_inference"
    if p.startswith(("runtime/", "engine/vendor/")):
        return "runtime"
    return "application"


def compute_size_breakdown(files_map: dict[str, dict]) -> dict:
    """Summarize total unpacked size and per-category byte/file counts."""
    buckets: dict[str, dict[str, int | float]] = {}
    total_bytes = 0
    for rel, info in files_map.items():
        size = int(info["bytes"])
        cat = classify_bundle_size_category(rel)
        entry = buckets.setdefault(cat, {"bytes": 0, "files": 0})
        entry["bytes"] = int(entry["bytes"]) + size
        entry["files"] = int(entry["files"]) + 1
        total_bytes += size
    for entry in buckets.values():
        entry["share_pct"] = round((int(entry["bytes"]) / total_bytes) * 100.0, 2) if total_bytes else 0.0
    return {
        "total_unpacked_bytes": total_bytes,
        "categories": dict(sorted(buckets.items())),
    }


def sanitize_dist_info_record(raw_text: str) -> str:
    """Remove direct_url.json and stripped binary/type-stub rows from a wheel RECORD."""
    cleaned_lines: list[str] = []
    for line in raw_text.splitlines():
        if not line.strip():
            continue
        first_col = line.split(",", 1)[0].strip()
        if first_col.endswith(("direct_url.json", ".pyc", ".pyi", ".pdb")) or "/__pycache__/" in first_col:
            continue
        cleaned_lines.append(line)
    return "\n".join(cleaned_lines) + "\n"


def get_input(spec: dict, offline: bool, directory: Path = DOWNLOADS) -> Path:
    destination = directory / spec["file"]
    if destination.is_file() and sha256(destination) == spec["sha256"]:
        return destination
    if destination.exists() or offline:
        raise RuntimeError(f"Missing or invalid pinned input: {destination}")
    directory.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=directory, suffix=".part", delete=False) as pending:
        with urlopen(spec["url"], timeout=60) as response:
            shutil.copyfileobj(response, pending)
    pending_path = Path(pending.name)
    if sha256(pending_path) != spec["sha256"]:
        raise RuntimeError(f"SHA-256 mismatch for {spec['file']}: {pending_path}")
    pending_path.replace(destination)
    return destination


def stage_file(stage: Path, name: str, source: Path | None = None) -> None:
    source = source if source is not None else ROOT / name
    if not source.is_file() or source.is_symlink() or not source.resolve().is_relative_to(ROOT):
        raise RuntimeError(f"Missing or invalid bundle source: {source}")
    destination = stage / name
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)


def stage_tree(stage: Path, name: str, source: Path, keep) -> None:
    if not source.is_dir() or source.is_symlink():
        raise RuntimeError(f"Invalid bundle source directory: {source}")
    for path in sorted(source.rglob("*")):
        if path.is_file():
            local = path.relative_to(source).as_posix()
            if keep(path, local):
                stage_file(stage, f"{name}/{local}", path)


def stage_vendor(stage: Path, lock: dict) -> None:
    """Copy vendored Python packages strictly from the pinned lock allowlist and scrub direct_url.json."""
    vendor_root = ROOT / "engine/vendor/python-cp311-win_amd64"
    allowed_pkgs = set(lock.get("vendor_packages") or ())
    pinned_files = lock.get("vendor_files") or {}
    if not allowed_pkgs or not pinned_files:
        raise RuntimeError("inputs.lock.json must pin vendor_packages and vendor_files")

    for rel, spec in sorted(pinned_files.items()):
        posix = PurePosixPath(rel)
        if posix.is_absolute() or ".." in posix.parts or posix.parts[0] not in allowed_pkgs:
            raise RuntimeError(f"Vendored file outside allowed package list: {rel}")
        if posix.name == "direct_url.json" or PRIVATE_PATH.search(rel):
            raise RuntimeError(f"Forbidden vendored file in lock: {rel}")
        source = vendor_root / rel
        if not source.is_file() or source.is_symlink() or not source.resolve().is_relative_to(vendor_root):
            raise RuntimeError(f"Missing or invalid vendored file: {source}")
        if source.stat().st_size != int(spec["bytes"]) or sha256(source) != spec["sha256"]:
            raise RuntimeError(f"Pinned vendor file SHA-256 or size mismatch: {rel}")

        dest = stage / "engine/vendor/python-cp311-win_amd64" / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        if posix.name == "RECORD" and len(posix.parts) >= 2 and posix.parts[0].endswith(".dist-info"):
            cleaned = sanitize_dist_info_record(source.read_text(encoding="utf-8"))
            if LOCAL_PATH_LEAK_RE.search(cleaned):
                raise RuntimeError(f"Local absolute path leak detected in sanitized RECORD: {rel}")
            dest.write_text(cleaned, encoding="utf-8")
        else:
            shutil.copyfile(source, dest)


def unzip_member(archive: ZipFile, member: str, into: Path, name: str | None = None) -> None:
    local = PurePosixPath(name or member)
    if local.is_absolute() or ".." in local.parts or any(":" in part or "\\" in part for part in local.parts):
        raise RuntimeError(f"Invalid archive member: {member}")
    destination = into.joinpath(*local.parts)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with archive.open(member) as read_stream, destination.open("xb") as write_stream:
        shutil.copyfileobj(read_stream, write_stream)


def stage_runtime(stage: Path, lock: dict, offline: bool) -> dict:
    directory = stage / "runtime"
    wheel_cache = DOWNLOADS / "wheels311"
    with ThreadPoolExecutor(max_workers=8) as workers:
        wheel_jobs = [workers.submit(get_input, spec, offline, wheel_cache) for spec in lock["wheels"]]
        local = {name: get_input(lock[name], offline) for name in ("python", "node", "node_license", "vc_runtime")}
        wheels = [job.result() for job in wheel_jobs]
    stage_file(stage, "runtime/node/node.exe", local["node"])
    stage_file(stage, "licenses/Node-LICENSE.txt", local["node_license"])
    py = directory / "python"
    with ZipFile(local["python"]) as embed:
        for member in embed.namelist():
            if member not in {"pythonw.exe", "python.cat", "python311._pth", "vcruntime140.dll", "vcruntime140_1.dll"}:
                unzip_member(embed, member, py)
    (py / "python311._pth").write_text("python311.zip\n.\nsite-packages\n../../engine\n", encoding="ascii")
    with ZipFile(local["vc_runtime"]) as vc:
        for dll in ("concrt140.dll", "msvcp140.dll", "msvcp140_1.dll", "msvcp140_2.dll",
                    "msvcp140_atomic_wait.dll", "msvcp140_codecvt_ids.dll", "vcomp140.dll",
                    "vcruntime140.dll", "vcruntime140_1.dll"):
            unzip_member(vc, dll, py)
        unzip_member(vc, "AppxManifest.xml", stage / "licenses", "VC-Runtime-AppxManifest.xml")

    for wheel in wheels:
        with ZipFile(wheel) as archive:
            if wheel.name.startswith("imageio_ffmpeg-"):
                binaries = [name for name in archive.namelist() if name.startswith("imageio_ffmpeg/binaries/") and name.endswith(".exe")]
                if len(binaries) != 1:
                    raise RuntimeError(f"Expected one FFmpeg executable in {wheel.name}")
                unzip_member(archive, binaries[0], directory / "media", "ffmpeg.exe")
                for name in archive.namelist():
                    if name.split("/")[-1].lower().startswith(("license", "copying")) and "/" in name:
                        unzip_member(archive, name, stage / "licenses" / "imageio-ffmpeg")
                continue
            for member in archive.namelist():
                if member.endswith("/"):
                    continue
                if member == "onnxruntime/capi/onnxruntime.dll":
                    # The pinned Python extension embeds ORT. This separate C API library has no consumer.
                    continue
                parts = PurePosixPath(member).parts
                if parts[0].endswith(".data") or member.endswith((".pdb", ".pyc", ".pyi", ".pth")) or parts[-1] in {"direct_url.json", "DELVEWHEEL"}:
                    continue
                if parts[0] in {"numpy", "scipy"} and "tests" in parts[:-1]:
                    continue
                if parts[:4] == ("scipy", "_lib", "array_api_compat", "torch"):
                    continue
                if parts[0] == "onnxruntime" and len(parts) >= 2 and parts[1] in {"transformers", "datasets"}:
                    continue
                unzip_member(archive, member, py / "site-packages")
    stage_vendor(stage, lock)
    return {
        "python": local["python"].name,
        "node": "24.13.0",
        "ffmpeg_wheel": next(path.name for path in wheels if path.name.startswith("imageio_ffmpeg-")),
        "vc_runtime": local["vc_runtime"].name,
        "vendor_packages": list(lock.get("vendor_packages") or ()),
    }


def stage_application(stage: Path, web: Path, lock: dict) -> None:
    stage_tree(stage, "public", web, lambda path, name: path.suffix != ".map")
    ja_accent_dir = stage / "public" / "vocal-tract" / "assets" / "ja-accent-v1"
    ja_accent_manifest = ja_accent_dir / "manifest.json"
    if not ja_accent_manifest.is_file():
        raise RuntimeError(f"Missing Japanese pitch-accent dictionary manifest: {ja_accent_manifest}")
    ja_manifest_data = json_file(ja_accent_manifest)
    for fname, meta in ja_manifest_data.get("files", {}).items():
        shard_path = ja_accent_dir / fname
        if not shard_path.is_file() or sha256(shard_path) != meta.get("sha256"):
            raise RuntimeError(f"Missing or corrupted Japanese pitch-accent shard: {shard_path}")
    stage_file(stage, "licenses/NAIST-JDIC-COPYING.txt", ROOT / "public/licenses/naist-jdic.txt")
    yue_dir = stage / "public" / "vocal-tract" / "assets" / "yue-jyutping-v1"
    yue_manifest = yue_dir / "manifest.json"
    if not yue_manifest.is_file():
        raise RuntimeError(f"Missing Cantonese Jyutping dictionary manifest: {yue_manifest}")
    yue_manifest_data = json_file(yue_manifest)
    for fname, meta in yue_manifest_data.get("files", {}).items():
        shard_path = yue_dir / fname
        if not shard_path.is_file() or sha256(shard_path) != meta.get("sha256"):
            raise RuntimeError(f"Missing or corrupted Cantonese Jyutping shard: {shard_path}")
    stage_file(stage, "licenses/RIME-CANTONESE-CC-BY-4.0.txt", ROOT / "public/licenses/rime-cantonese-cc-by-4.0.txt")
    stage_file(stage, "licenses/UNICODE-LICENSE-V3.txt", ROOT / "public/licenses/unicode-license-v3.txt")
    for name in ("card-encoding", "portable", "portable-cache", "proxy", "studio-encoding"):
        stage_file(stage, f"server/{name}.mjs")
    for name in ENGINE_FILES:
        stage_file(stage, f"engine/{name}.py")
    stage_tree(stage, "engine/vtl_native", ROOT / "engine/vtl_native",
               lambda path, name: path.suffix in {".py", ".json", ".dll", ".speaker"})
    for name in MODEL_FILES:
        override = MODEL_FILE_OVERRIDES.get(name)
        stage_file(stage, f"engine/model_bundle/{name}", (ROOT / override) if override else None)
    for directory, models in SDK_MODULES.items():
        for name in models.split():
            stage_file(stage, f"engine/model_bundle/{directory}/{name}.py")
    for name in ("canonical_ipa_poses.json", "jd2_starter_fallback_poses.json"):
        stage_file(stage, f"engine/model_bundle/packages/kf_ipa_synth/assets/{name}")
    for name in ("TIMITDIC.TXT", "mandarin_mfa.dict", "mandarin_china_mfa.dict", "mandarin_beijing_ipa.json"):
        stage_file(stage, f"engine/model_bundle/packages/kf_ipa_synth/assets/lexicon/{name}")
    for name in ("dpdfnet2_48khz_hr.onnx", "swift-f0-0.3.0.onnx", "manifest.json", "SwiftF0-MIT.txt"):
        stage_file(stage, f"engine/model_bundle/ptb/resources/neural/{name}")

    # Verify all 8 pinned Batch-2 ONNX slots and paired model assets against inputs.lock.json.
    pinned_onnx = lock.get("onnx_models") or {}
    if set(pinned_onnx.keys()) != OFFICIAL_ONNX_SLOTS:
        raise RuntimeError("inputs.lock.json onnx_models must pin the exact 8 Batch-2 ONNX slots")
    for rel, spec in {**pinned_onnx, **(lock.get("model_assets") or {})}.items():
        staged = stage / rel
        if not staged.is_file() or staged.stat().st_size != int(spec["bytes"]) or sha256(staged) != spec["sha256"]:
            raise RuntimeError(f"Pinned ONNX/asset SHA-256 or size mismatch: {rel}")

    library = "engine/reference_library"
    for name in ("index.json", "poses.json", "vowel-formants.json", "vowel-transfer-jd2-65.json", "trill-demos/index.json"):
        stage_file(stage, f"{library}/{name}")
    for entry in json_file(ROOT / library / "index.json"):
        tag = entry["id"]
        if not re.fullmatch(r"[A-Za-z0-9_-]+", tag):
            raise RuntimeError(f"Invalid reference recording id: {tag}")
        for relative in (f"{tag}.json", f"voqs/{tag}.json", f"textgrids/{tag}.TextGrid",
                         f"trill-demos/{tag}.json", f"trill-demos/{tag}.mp3"):
            if (ROOT / library / relative).is_file():
                stage_file(stage, f"{library}/{relative}")
    for entry in json_file(ROOT / library / "trill-demos/index.json"):
        tag = entry["id"]
        if not re.fullmatch(r"trill-[a-z-]+", tag):
            raise RuntimeError(f"Invalid trill reference id: {tag}")
        stage_file(stage, f"{library}/trill-demos/{tag}.mp3")
        track = f"{library}/trill-demos/{tag}.json"
        if (ROOT / track).is_file():
            stage_file(stage, track)
    stage_file(stage, "src/data/voqs-recordings.json")
    for name in ("LICENSE", "DISCLOSURE.md", "THIRD_PARTY.md"):
        stage_file(stage, f"licenses/{name}", ROOT / name)
    stage_file(stage, "VoxFigura.cmd", SCRIPTS / "VoxFigura.cmd")
    stage_file(stage, "README.txt", SCRIPTS / "README.txt")


def find_cargo() -> Path:
    found = shutil.which("cargo")
    if found:
        return Path(found)
    candidate = Path.home() / ".cargo" / "bin" / "cargo.exe"
    if candidate.is_file():
        return candidate
    raise RuntimeError("Rust/Cargo is required on the build host to compile the Tauri 2 desktop launcher")


def read_rustc_version(cargo: Path) -> str:
    rustc = cargo.parent / ("rustc.exe" if os.name == "nt" else "rustc")
    exe = str(rustc) if rustc.is_file() else (shutil.which("rustc") or "rustc")
    return subprocess.check_output([exe, "-V"], cwd=ROOT, text=True).strip()


def build_tauri_shell() -> tuple[Path, str, str]:
    tauri_dir = ROOT / "src-tauri"
    icon_src = SCRIPTS / "VoxFigura.ico"
    if not icon_src.is_file():
        raise RuntimeError(f"Missing application icon: {icon_src}")
    icon_dst = tauri_dir / "icons" / "icon.ico"
    app_png_src = ROOT / "public" / "app-icon.png"
    app_png_dst = tauri_dir / "dist" / "app-icon.png"

    # P-06: Avoid dirtying tracked repository files; restore any temporarily synced asset in finally.
    backups: list[tuple[Path, bytes | None]] = []
    try:
        for src, dst in ((icon_src, icon_dst), (app_png_src, app_png_dst)):
            if not src.is_file():
                continue
            if dst.is_file() and sha256(dst) == sha256(src):
                continue
            backups.append((dst, dst.read_bytes() if dst.is_file() else None))
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, dst)

        cargo = find_cargo()
        rustc_version = read_rustc_version(cargo)
        cargo_lock_sha256 = sha256(tauri_dir / "Cargo.lock")
        env = os.environ.copy()
        cargo_bin = str(cargo.parent)
        if cargo_bin.lower() not in env.get("PATH", "").lower():
            env["PATH"] = cargo_bin + os.pathsep + env.get("PATH", "")
        subprocess.run(
            [str(cargo), "build", "--release", "--locked", "--manifest-path", str(tauri_dir / "Cargo.toml")],
            cwd=ROOT,
            env=env,
            check=True,
        )
        shell_exe = tauri_dir / "target" / "release" / "voxfigura-desktop.exe"
        if not shell_exe.is_file():
            raise RuntimeError(f"Expected Tauri launcher executable at {shell_exe}")
        return shell_exe, rustc_version, cargo_lock_sha256
    finally:
        for dst, previous in reversed(backups):
            if previous is None:
                if dst.exists():
                    dst.unlink()
            else:
                dst.write_bytes(previous)


def build_executable(stage: Path, extractor: Path, edition: str, shell_exe: Path) -> tuple[Path, Path]:
    work = stage.parent
    archive = work / "payload.7z"
    subprocess.run([str(extractor), "a", "-t7z", "-sccUTF-8", "-m0=LZMA2:d=32m", "-mx=7",
                    "-ms=on", "-mmt=4", "-bd", str(archive), "."], cwd=stage, check=True)
    archive_hash = sha256(archive)
    manifest_hash = sha256(stage / "bundle-manifest.json")
    extractor_hash = sha256(extractor)
    shell_hash = sha256(shell_exe)
    identity = work / "payload-identity.txt"
    identity.write_text(
        f"{edition}\n{archive_hash}\n{manifest_hash}\n{extractor_hash}\n{shell_hash}\n",
        encoding="utf-8",
    )

    executable = work / f"{stage.name}.exe"
    with executable.open("wb") as out:
        with shell_exe.open("rb") as src:
            shutil.copyfileobj(src, out, 1024 * 1024)
        extractor_offset = out.tell()
        with extractor.open("rb") as src:
            shutil.copyfileobj(src, out, 1024 * 1024)
        extractor_len = out.tell() - extractor_offset

        archive_offset = out.tell()
        with archive.open("rb") as src:
            shutil.copyfileobj(src, out, 1024 * 1024)
        archive_len = out.tell() - archive_offset

        meta_bytes = json.dumps({
            "edition": edition,
            "archive_sha256": archive_hash,
            "manifest_sha256": manifest_hash,
            "extractor_sha256": extractor_hash,
            "extractor_offset": extractor_offset,
            "extractor_len": extractor_len,
            "archive_offset": archive_offset,
            "archive_len": archive_len,
        }, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        meta_offset = out.tell()
        out.write(meta_bytes)
        out.write(struct.pack("<QQ8s", meta_offset, len(meta_bytes), b"VFPORT2!"))
    return executable, archive


def build(edition: str, offline: bool, stage_only: bool) -> None:
    if sysconfig.get_platform() != "win-amd64":
        raise RuntimeError("Build requires an x64 Windows host and 64-bit Python")
    lock = json_file(SCRIPTS / "inputs.lock.json")
    version = json_file(ROOT / "package.json")["version"]
    name = f"VoxFigura-{edition}-{version}-win-x64-cpu-api-local"
    OUTPUT.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix=f"{edition}-", dir=OUTPUT))
    stage = work / name
    web = work / "web"
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node.js is needed on the build host")
    subprocess.run([node, str(ROOT / "node_modules/vite/bin/vite.js"), "build", "--mode", edition,
                    "--outDir", str(web)], cwd=ROOT, env={**os.environ, "VOCALCUT_PORTABLE": "1"}, check=True)
    subprocess.run([node, "scripts/check-edition.mjs", edition, str(web)], cwd=ROOT, check=True)
    stage_application(stage, web, lock)
    runtimes = stage_runtime(stage, lock, offline)
    subprocess.run([str(stage / "runtime/python/python.exe"), "-B", "-X", "utf8",
                    str(SCRIPTS / "encode_references.py"), str(ROOT / "engine/reference_library"), str(stage)],
                   cwd=ROOT, check=True)
    save_json(stage / "licenses" / "portable-inputs.lock.json", lock)

    shell_exe: Path | None = None
    extractor: Path | None = None
    build_toolchain: dict[str, str] = {
        "cargo_lock_sha256": sha256(ROOT / "src-tauri" / "Cargo.lock"),
        "archive_tool_sha256": str(lock["archive_tool"]["sha256"]),
    }
    if not stage_only:
        extractor = get_input(lock["archive_tool"], offline)
        shell_exe, rustc_version, cargo_lock_sha256 = build_tauri_shell()
        build_toolchain.update({
            "rustc_version": rustc_version,
            "cargo_lock_sha256": cargo_lock_sha256,
            "shell_exe_sha256": sha256(shell_exe),
            "archive_tool_sha256": sha256(extractor),
        })

    manifest = {
        "edition": edition,
        "version": version,
        "platform": "win-x64",
        "compute": "cpu",
        "audience": "local-validation-only",
        "transcription": "api-or-manual",
        "reference_audio": "mp3-192kbps",
        "runtimes": runtimes,
        "npm_lock_sha256": sha256(ROOT / "package-lock.json"),
        "build_toolchain": build_toolchain,
        "files": {},
    }
    found_onnx: set[str] = set()
    found_server: set[str] = set()
    for path in sorted(stage.rglob("*")):
        if not path.is_file():
            continue
        local = path.relative_to(stage).as_posix()
        if PRIVATE_PATH.search(local) and local != "runtime/python/python311._pth":
            raise RuntimeError(f"Forbidden bundle file: {local}")
        if path.suffix.lower() == ".wav" and local.startswith(("public/", "engine/reference_library/")):
            raise RuntimeError(f"Convert packaged example audio to MP3 before shipping: {local}")
        if path.suffix.lower() == ".onnx":
            found_onnx.add(local)
        if local.startswith("server/"):
            found_server.add(local)
        manifest["files"][local] = {"bytes": path.stat().st_size, "sha256": sha256(path)}

    if found_onnx != OFFICIAL_ONNX_SLOTS:
        extra = sorted(found_onnx - OFFICIAL_ONNX_SLOTS)
        missing = sorted(OFFICIAL_ONNX_SLOTS - found_onnx)
        raise RuntimeError(f"Packaged ONNX slots mismatch: extra={extra}, missing={missing}")
    if found_server != ALLOWED_SERVER_FILES:
        raise RuntimeError(f"Packaged server files mismatch: {sorted(found_server)}")

    size_breakdown = compute_size_breakdown(manifest["files"])
    manifest["size_breakdown"] = size_breakdown
    save_json(stage / "bundle-manifest.json", manifest)

    size_report = {
        "edition": edition,
        "version": version,
        "unpacked_bytes": size_breakdown["total_unpacked_bytes"],
        "size_breakdown": size_breakdown,
        "build_toolchain": build_toolchain,
    }
    print(f"STAGE={stage}", flush=True)
    if stage_only:
        report_path = work / "size-report.json"
        save_json(report_path, size_report)
        print(f"SIZE_REPORT={report_path}", flush=True)
        return

    assert extractor is not None and shell_exe is not None
    exe, archive = build_executable(stage, extractor, edition, shell_exe)
    exe_sha = sha256(exe)
    sidecar = exe.with_suffix(".exe.sha256")
    sidecar.write_text(f"{exe_sha}  {exe.name}\n", encoding="ascii")
    size_report.update({
        "exe_name": exe.name,
        "exe_bytes": exe.stat().st_size,
        "exe_sha256": exe_sha,
        "archive_bytes": archive.stat().st_size,
    })
    report_path = exe.with_name(f"{stage.name}.size-report.json")
    save_json(report_path, size_report)
    print(f"EXE={exe}", flush=True)
    print(f"EXE_BYTES={exe.stat().st_size}", flush=True)
    print(f"SIZE_REPORT={report_path}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--edition", choices=("public",), default="public")
    parser.add_argument("--offline", action="store_true", help="require all pinned downloads in the local build cache")
    parser.add_argument("--stage-only", action="store_true", help="assemble a directory without creating an EXE")
    args = parser.parse_args()
    build(args.edition, args.offline, args.stage_only)
