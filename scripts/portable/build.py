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
audio_transitions chunked_synthesis dense_channel dpdf_audio
high_pitch_preview ipa_articulation ipa_glottis_movie ipa_library_bundle ipa_materials
ipa_recording_edits ipa_reference_library ipa_reference_trajectory keyframe_lite m27_bridge
model_registry_runtime onnx_frontends onnx_inference prosody_bridge realtime_m27 server
swift_pitch trills validation voice_morph_bridge voqs_creak voqs_reference vowel_response
""".split()
MODEL_FILES = """
models/manifest.json
models/Vox2Tract-Lite/vox2tract_lite.onnx
models/Vox2Align-Lite/vox2align_lite_v2.onnx
models/IPA2Tract-Lite/ipa2tract_lite.onnx
models/IPA2Tract-Lite/tract2area_proxy.onnx
models/Tract2Vox-Lite/tract2vox_lite.onnx
models/Vox2Spk-Lite/vox2spk_lite.onnx
models/Text2Prosody-Lite/text2prosody_lite.onnx
speakers/jingjing-lecture.spk.json
speakers/jingjing.spk.json
""".split()
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
    r"faster_whisper(?:-[^/]*)?|ctranslate2(?:-[^/]*)?|av(?:\.libs|-[^/]*)?|"
    r"pyopenjtalk(?:-[^/]*)?|"
    r"huggingface_hub(?:-[^/]*)?|tokenizers(?:-[^/]*)?)(?:/|$)"
    r"|\.(?:pt|pth|ckpt|key|pfx|pdb|pyc|map)$|(?:cu(?:da|dnn|blas|fft|rtc)[^/]*|"
    r"nvrtc[^/]*|onnxruntime_providers_(?:cuda|tensorrt))\.dll$",
    re.IGNORECASE,
)


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return file_digest(stream, "sha256").hexdigest()


def json_file(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def save_json(path: Path, value) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


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
                if parts[0].endswith(".data") or member.endswith((".pdb", ".pyc", ".pyi", ".pth")):
                    continue
                if parts[0] in {"numpy", "scipy"} and "tests" in parts[:-1]:
                    continue
                unzip_member(archive, member, py / "site-packages")
    stage_tree(stage, "engine/vendor/python-cp311-win_amd64",
               ROOT / "engine/vendor/python-cp311-win_amd64",
               lambda path, name: not path.suffix in {".pyc", ".pyi", ".pdb"} and "__pycache__/" not in name)
    return {
        "python": local["python"].name,
        "node": "24.13.0",
        "ffmpeg_wheel": next(path.name for path in wheels if path.name.startswith("imageio_ffmpeg-")),
        "vc_runtime": local["vc_runtime"].name,
    }


def stage_application(stage: Path, web: Path) -> None:
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
    for name in ("card-encoding", "portable", "portable-cache", "proxy", "studio-encoding"):
        stage_file(stage, f"server/{name}.mjs")
    for name in ENGINE_FILES:
        stage_file(stage, f"engine/{name}.py")
    stage_tree(stage, "engine/vtl_native", ROOT / "engine/vtl_native",
               lambda path, name: path.suffix in {".py", ".json", ".dll", ".speaker"})
    for name in MODEL_FILES:
        stage_file(stage, f"engine/model_bundle/{name}")
    for directory, models in SDK_MODULES.items():
        for name in models.split():
            stage_file(stage, f"engine/model_bundle/{directory}/{name}.py")
    for name in ("canonical_ipa_poses.json", "jd2_starter_fallback_poses.json"):
        stage_file(stage, f"engine/model_bundle/packages/kf_ipa_synth/assets/{name}")
    for name in ("TIMITDIC.TXT", "mandarin_mfa.dict", "mandarin_china_mfa.dict", "mandarin_beijing_ipa.json"):
        stage_file(stage, f"engine/model_bundle/packages/kf_ipa_synth/assets/lexicon/{name}")
    for name in ("dpdfnet2_48khz_hr.onnx", "swift-f0-0.3.0.onnx", "manifest.json", "SwiftF0-MIT.txt"):
        stage_file(stage, f"engine/model_bundle/ptb/resources/neural/{name}")

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


def build_tauri_shell() -> Path:
    tauri_dir = ROOT / "src-tauri"
    icon_src = SCRIPTS / "VoxFigura.ico"
    if not icon_src.is_file():
        raise RuntimeError(f"Missing application icon: {icon_src}")
    icon_dst = tauri_dir / "icons" / "icon.ico"
    icon_dst.parent.mkdir(parents=True, exist_ok=True)
    if not icon_dst.is_file() or sha256(icon_dst) != sha256(icon_src):
        shutil.copyfile(icon_src, icon_dst)
    app_png_src = ROOT / "public" / "app-icon.png"
    if app_png_src.is_file():
        app_png_dst = tauri_dir / "dist" / "app-icon.png"
        if not app_png_dst.is_file() or sha256(app_png_dst) != sha256(app_png_src):
            shutil.copyfile(app_png_src, app_png_dst)
    cargo = find_cargo()
    env = os.environ.copy()
    cargo_bin = str(cargo.parent)
    if cargo_bin.lower() not in env.get("PATH", "").lower():
        env["PATH"] = cargo_bin + os.pathsep + env.get("PATH", "")
    subprocess.run([str(cargo), "build", "--release", "--manifest-path", str(tauri_dir / "Cargo.toml")],
                   cwd=ROOT, env=env, check=True)
    shell_exe = tauri_dir / "target" / "release" / "voxfigura-desktop.exe"
    if not shell_exe.is_file():
        raise RuntimeError(f"Expected Tauri launcher executable at {shell_exe}")
    return shell_exe


def build_executable(stage: Path, extractor: Path, edition: str) -> Path:
    work = stage.parent
    archive = work / "payload.7z"
    subprocess.run([str(extractor), "a", "-t7z", "-sccUTF-8", "-m0=LZMA2:d=32m", "-mx=7",
                    "-ms=on", "-mmt=4", "-bd", str(archive), "."], cwd=stage, check=True)
    archive_hash = sha256(archive)
    manifest_hash = sha256(stage / "bundle-manifest.json")
    identity = work / "payload-identity.txt"
    identity.write_text(f"{edition}\n{archive_hash}\n{manifest_hash}\n", encoding="utf-8")

    shell_exe = build_tauri_shell()
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
            "extractor_offset": extractor_offset,
            "extractor_len": extractor_len,
            "archive_offset": archive_offset,
            "archive_len": archive_len,
        }, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        meta_offset = out.tell()
        out.write(meta_bytes)
        out.write(struct.pack("<QQ8s", meta_offset, len(meta_bytes), b"VFPORT2!"))
    return executable


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
    stage_application(stage, web)
    runtimes = stage_runtime(stage, lock, offline)
    subprocess.run([str(stage / "runtime/python/python.exe"), "-B", "-X", "utf8",
                    str(SCRIPTS / "encode_references.py"), str(ROOT / "engine/reference_library"), str(stage)],
                   cwd=ROOT, check=True)
    save_json(stage / "licenses" / "portable-inputs.lock.json",
              {name: value for name, value in lock.items() if name != "asr_build_wheels"})
    manifest = {"edition": edition, "version": version, "platform": "win-x64", "compute": "cpu",
                "audience": "local-validation-only", "transcription": "api-or-manual",
                "reference_audio": "mp3-192kbps", "runtimes": runtimes,
                "npm_lock_sha256": sha256(ROOT / "package-lock.json"), "files": {}}
    for path in sorted(stage.rglob("*")):
        if not path.is_file():
            continue
        local = path.relative_to(stage).as_posix()
        if PRIVATE_PATH.search(local) and local != "runtime/python/python311._pth":
            raise RuntimeError(f"Forbidden bundle file: {local}")
        if path.suffix.lower() == ".wav" and local.startswith(("public/", "engine/reference_library/")):
            raise RuntimeError(f"Convert packaged example audio to MP3 before shipping: {local}")
        manifest["files"][local] = {"bytes": path.stat().st_size, "sha256": sha256(path)}
    save_json(stage / "bundle-manifest.json", manifest)
    print(f"STAGE={stage}", flush=True)
    if stage_only:
        return
    exe = build_executable(stage, get_input(lock["archive_tool"], offline), edition)
    sidecar = exe.with_suffix(".exe.sha256")
    sidecar.write_text(f"{sha256(exe)}  {exe.name}\n", encoding="ascii")
    print(f"EXE={exe}", flush=True)
    print(f"EXE_BYTES={exe.stat().st_size}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--edition", choices=("public", "friends"), required=True)
    parser.add_argument("--offline", action="store_true", help="require all pinned downloads in the local build cache")
    parser.add_argument("--stage-only", action="store_true", help="assemble a directory without creating an EXE")
    args = parser.parse_args()
    build(args.edition, args.offline, args.stage_only)
