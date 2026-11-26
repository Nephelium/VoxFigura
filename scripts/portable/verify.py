"""Verify a portable staging directory or exercise the single-file EXE."""
from __future__ import annotations

import argparse
import base64
from collections import deque
from contextlib import contextmanager
from hashlib import sha256
from io import BytesIO
import json
import os
from pathlib import Path
import re
import shutil
from socket import create_connection
import subprocess
import tempfile
from threading import Event, Thread
from time import monotonic, sleep
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, Request, build_opener
from zipfile import ZipFile

from build import PRIVATE_PATH, sha256 as file_sha256


PORTS = {"public": 26751, "friends": 26752}
HTTP = build_opener(ProxyHandler({}))


def require(condition, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


@contextmanager
def extracted(path: Path):
    if path.is_dir():
        with tempfile.TemporaryDirectory(prefix="VoxFigura stage test ") as directory:
            scratch = Path(directory)
            stage = scratch / "bundle"
            shutil.copytree(path, stage)
            yield stage, None, scratch / "全新用户缓存"
        return
    require(path.suffix.lower() == ".exe", "The deliverable must be an EXE")
    sidecar = path.with_suffix(".exe.sha256").read_text(encoding="ascii").split()
    require(sidecar == [file_sha256(path), path.name], "EXE SHA-256 or name did not match")
    with tempfile.TemporaryDirectory(prefix="VoxFigura portable test ") as directory:
        local = Path(directory) / "全新用户缓存"
        env = clean_environment(local)
        result = subprocess.run([str(path), "--extract-only"], cwd=directory, env=env,
                                capture_output=True, encoding="utf-8", errors="replace", timeout=240)
        require(result.returncode == 0, f"EXE extraction failed: {result.stdout}\n{result.stderr}")
        locations = [Path(line.removeprefix("BUNDLE=")) for line in result.stdout.splitlines() if line.startswith("BUNDLE=")]
        require(len(locations) == 1 and locations[0].is_relative_to(local), "EXE did not use the isolated user cache")
        yield locations[0], path, local


def clean_environment(local: Path | None = None) -> dict[str, str]:
    env = {key: value for key, value in os.environ.items() if key.lower() in {
        "systemroot", "windir", "systemdrive", "temp", "tmp", "userprofile", "localappdata", "appdata",
    }}
    env["Path"] = str(Path(env.get("SystemRoot", r"C:\Windows")) / "System32")
    if local is not None:
        env["LOCALAPPDATA"] = str(local)
    return env


def get_http(address, path, body=None, *, status=200, method=None, headers=None):
    request_headers = dict(headers or {})
    if isinstance(body, dict):
        request_headers["Content-Type"] = "application/json"
        body = json.dumps(body, ensure_ascii=False).encode("utf-8")
    try:
        response = HTTP.open(Request(address + path, data=body, headers=request_headers, method=method), timeout=120)
    except HTTPError as error:
        response = error
    with response:
        output = response.read()
        require(response.status == status, f"{path}: HTTP {response.status}, expected {status}, {output[:600]!r}")
        return output


def verify_files(stage: Path) -> dict:
    manifest = json.loads((stage / "bundle-manifest.json").read_text(encoding="utf-8"))
    require(manifest["compute"] == "cpu" and manifest["platform"] == "win-x64", "Wrong target")
    require(manifest["audience"] == "local-validation-only", "Missing local package audience")
    require(manifest["transcription"] == "api-or-manual", "Wrong transcription capability")
    require(manifest["reference_audio"] == "mp3-192kbps", "Wrong reference recording encoding")
    expected = manifest["files"]
    files = {item.relative_to(stage).as_posix(): item for item in stage.rglob("*") if item.is_file()}
    require(files.keys() == expected.keys() | {"bundle-manifest.json"}, "Unexpected or missing bundled file")
    for name, info in expected.items():
        path = files[name]
        require(not PRIVATE_PATH.search(name) or name == "runtime/python/python311._pth",
                f"Forbidden runtime file: {name}")
        require(name not in {"engine/asr_install.py", "engine/asr_models.py", "engine/speech_to_text.py"},
                f"Local transcription code included: {name}")
        require(path.suffix.lower() != ".wav" or not name.startswith(("public/", "engine/reference_library/")),
                f"Unexpected uncompressed example WAV: {name}")
        require(path.stat().st_size == info["bytes"] and file_sha256(path) == info["sha256"],
                f"Bundle manifest mismatch: {name}")
    library = stage / "engine/reference_library"
    metadata = json.loads((library / "media-encoding.json").read_text(encoding="utf-8"))
    entries = json.loads((library / "index.json").read_text(encoding="utf-8"))
    originals = {
        entry["id"]: ("microphone" if entry.get("from_take") else "recordings") + "/" + entry["id"] + ".mp3"
        for entry in entries if entry.get("exists")
    }
    require(metadata["format"] == "MP3" and metadata["bitrate_kbps"] == 192 and
            {row["id"]: row["file"] for row in metadata["recordings"]} == originals,
            "Encoded reference index did not match the source recording index")
    for folder in ("recordings", "microphone"):
        found = {path.relative_to(library).as_posix() for path in (library / folder).iterdir() if path.is_file()}
        require(found == {name for name in originals.values() if name.startswith(folder + "/")},
                f"Unexpected or missing recording in {folder}")
    return manifest


def check_exports(address: str, ffmpeg: Path, audio: bytes) -> None:
    for fmt, signature in (("wav", b"RIFF"), ("flac", b"fLaC"), ("mp3", b"ID3"), ("m4a", b"ftyp")):
        exported = get_http(address, f"/api/studio/audio?format={fmt}", audio)
        require(signature in exported[:24], f"Invalid {fmt} export")
    frame = subprocess.check_output([str(ffmpeg), "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
                                     "color=c=white:s=360x360", "-frames:v", "1", "-vcodec", "png", "-f",
                                     "image2pipe", "pipe:1"])
    for fmt, signature in (("gif", b"GIF"), ("mp4", b"ftyp")):
        result = get_http(address, f"/api/explore/card-encode?format={fmt}&fps=15", frame * 3,
                          headers={"Content-Type": "application/octet-stream"})
        require(signature in result[:24], f"Invalid card {fmt} export")
    job = json.loads(get_http(address, "/api/studio/movie?fps=30", b"", status=201))
    try:
        require(job["encoder"] == "libx264", "Movie did not select CPU H.264")
        jpeg = subprocess.check_output([str(ffmpeg), "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
                                        "color=c=white:s=360x360", "-frames:v", "1", "-vcodec", "mjpeg", "-f",
                                        "image2pipe", "pipe:1"])
        frames = jpeg * 3
        batch = f"first=0&count=3&sha256={sha256(frames).hexdigest()}"
        get_http(address, f"/api/studio/movie/{job['id']}/frames?{batch}", frames)
        finish = f"frames=3&sound=1&sha256={sha256(audio).hexdigest()}"
        movie = get_http(address, f"/api/studio/movie/{job['id']}/finish?{finish}", audio)
        require(b"ftyp" in movie[:24], "Invalid studio MP4 export")
    finally:
        get_http(address, f"/api/studio/movie/{job['id']}", method="DELETE")


def check_features(address: str, stage: Path, speech: dict[str, tuple[Path, str]], full_library: bool) -> dict:
    def call(path, data=None):
        return json.loads(get_http(address, path, data))

    page = get_http(address, "/").decode("utf-8")
    bundle = re.search(r'<script type="module"[^>]+src="(/assets/[^"]+)"', page)
    require(bundle is not None and get_http(address, bundle[1]), "Missing Vite entry")
    for resource in ("/vocal-tract/embed.mjs", "/fonts/PTBIPAPlus-Regular.ttf",
                     "/data/ipa-plus-catalog.json", "/mediapipe-0.10.14/face-worker.js"):
        require(get_http(address, resource), f"Missing web asset {resource}")
    demo_urls = [item["wav_url"] for item in call("/prewarm/index.json")["cases"]]
    demo_urls.extend(f"/onboarding/{name}.mp3" for name in ("demo_zh_spkA", "demo_zh_spkB", "demo_en"))
    for url in demo_urls:
        mp3 = get_http(address, url)
        require(url.endswith(".mp3") and mp3[:2] == b"\xff\xfb" and mp3[2] >> 4 == 11,
                f"Example is missing a 192 kbps MP3 stream: {url}")
    get_http(address, "/api/explore/repo-search", status=404)
    get_http(address, "/api/zhihu/search", status=404)
    get_http(address, "/api/health", status=403, headers={"Origin": "https://example.org"})
    get_http(address, "/bundle-manifest.json", status=404)

    models = call("/api/models/local")
    providers = set(models["runtime_providers"])
    require(models["available_count"] == 9 and "CPUExecutionProvider" in providers and
            providers <= {"CPUExecutionProvider", "AzureExecutionProvider"} and not models["cuda_available"],
            f"Unexpected model count/providers: {models['available_count']} {models['runtime_providers']}")
    loaded = call("/api/models/local/load", {"all": True, "device": "cpu"})
    active = call("/api/models/local")
    require(loaded["ok"] and active["in_memory_count"] == 9 and
            all(slot["provider"] == "CPUExecutionProvider" for slot in active["models"]),
            "Loading all nine models on CPU failed")
    metadata = call("/api/vtl/meta?speaker=JD2")
    params = [item["neutral"] for item in metadata["parameters"]]
    require(len(params) == 19 and call("/api/vtl/meta?speaker=W02")["parameters"], "VTL speakers unavailable")
    live = call("/api/vtl/live-pull", {"speaker": "JD2", "reset": True, "blocks": 3, "params": params,
                                     "f0_hz": 168, "pressure_pa": 780})
    require(live["ok"] and len(base64.b64decode(live["pcm_f32_b64"])) == 2880 * 4, "VTL synthesis failed")
    prosody = call("/api/models/text-prosody", {"text": "你好 world", "lang": "auto", "base_f0": 150})
    require(prosody["ok"] and prosody["keyframes"], "Text2Prosody-Lite failed")
    require(call("/api/models/voice-morph").get("ok"), "Voice mixer did not initialize")

    library = call("/api/models/ipa-references/index")["records"]
    require(len(library) >= 250 and any(item["has_textgrid"] for item in library), "IPA/TextGrid library incomplete")
    library_route = "/api/models/ipa-references/library-bundle"
    if full_library:
        get_http(address, library_route, {"include_video": False}, status=202)
    ipa = next(item for item in library if item["id"] == "main-T001")
    require(ipa["exists"] and ipa["animation"], "Reference audio/trajectory missing")
    ref_url = "/api/models/ipa-references/main-T001"
    audio = get_http(address, ref_url + "/audio")
    require(audio.startswith(b"RIFF"), "Reference WAV failed")
    require(get_http(address, ref_url + "/audio?audio_gain=original").startswith(b"RIFF"),
            "MP3 reference at original level failed to return decoded WAV")
    require(get_http(address, ref_url + "/reconstruction").startswith(b"RIFF"), "Neural voice synthesis failed")
    revised = call("/api/models/ipa-recording-edits/render", {"recording_id": ipa["id"], "mode": "neural",
        "keyframes": [{"frame": 0, "radius": 2, "values": {"F0": 175}}], "device": "cpu"})
    require(revised["ok"] and base64.b64decode(revised["wav_base64"]).startswith(b"RIFF"),
            "Neural revision from MP3 reference failed")
    with ZipFile(BytesIO(get_http(address, ref_url + "/bundle-video"))) as archive:
        members = archive.namelist()
        require(any(name.endswith(".mp4") for name in members) and any(name.endswith(".TextGrid") for name in members),
                "Reference bundle missing glottis MP4 or a TextGrid")
        saved = json.loads(archive.read("manifest.json"))
        require(saved["source_window"]["source_audio_encoding"] == "MP3" and
                archive.read(saved["files"]["original"]).startswith(b"RIFF"),
                "Reference ZIP did not preserve WAV compatibility and MP3 provenance")
    voqs = next(item for item in library if item.get("voqs") and item["exists"] and item["has_glottis"])
    track = call(f"/api/models/ipa-references/{voqs['id']}/voqs-track")
    require(track["ok"] and track["rows"], "VoQS track from MP3 reference unavailable")
    trills = call("/api/models/ipa-references/trill-demos")["records"]
    fallback_trills = [item for item in library if item.get("synthesized_trill")]
    require(trills and fallback_trills, "Synthetic trill demos or IPA fallback recordings missing")
    for demo in [*trills, *fallback_trills]:
        audio_url = f"/api/models/ipa-references/{demo['id']}/audio?audio_gain=original"
        require(get_http(address, audio_url).startswith(b"RIFF"), f"Trill MP3 playback failed: {demo['id']}")
    get_http(address, "/api/m27/asr-install", status=404)
    get_http(address, "/api/m27/asr-install", {"model": "tiny"}, status=404)
    get_http(address, "/api/m27/transcribe", {}, status=404)
    cloud = json.loads(get_http(address, "/api/ai/deepseek-asr", audio, status=400,
                                headers={"Content-Type": "audio/wav"}))
    require("DeepSeek API Key" in cloud["hint"], "Cloud transcription route unavailable")
    check_exports(address, stage / "runtime/media/ffmpeg.exe", audio)

    for language, (fixture, text) in speech.items():
        wav = base64.b64encode(fixture.read_bytes()).decode("ascii")
        alignment = call("/api/m27/align", {"wav_base64": wav, "lang": language, "text": text, "device": "cpu"})
        require(alignment["ok"] and alignment["alignment"], f"Vox2Align-Lite v2 {language} alignment failed")
    if full_library:
        deadline = monotonic() + 180
        while True:
            state = call(library_route)
            if state["state"] == "ready":
                break
            require(state["state"] == "building" and monotonic() < deadline, f"Full library export failed: {state}")
            sleep(2)
        with ZipFile(BytesIO(get_http(address, state["download_url"]))) as archive:
            library_manifest = json.loads(archive.read("manifest.json"))
            records = library_manifest["records"]
            actual_originals = sum(item["exists"] and not item.get("synthesized_trill") for item in library)
            require(len(records) == actual_originals and archive.testzip() is None and
                    all(row["source_window"]["source_audio_encoding"] == "MP3" for row in records),
                    "Full library export omitted MP3 source recordings or provenance")
            demos = library_manifest["supplemental_demos"]
            require({row["id"] for row in demos} == {demo["id"] for demo in trills} and
                    all(row["source_audio_encoding"] == "MP3" and archive.read(row["file"]).startswith(b"RIFF")
                        for row in demos), "Full library export omitted MP3-backed trill supplements")
    return {"models": len(models["models"]), "ipa_entries": len(library), "manual_text_alignment": sorted(speech),
            "local_asr_routes": "unavailable", "deepseek_config_validation": "passed",
            "full_library_export": full_library,
            "exports": ["wav", "flac", "mp3", "m4a", "card gif", "card mp4", "studio mp4", "glottis mp4"]}


def run(stage: Path, speech: dict[str, tuple[Path, str]], exe: Path | None, local: Path | None, full_library: bool) -> dict:
    manifest = verify_files(stage)
    port = PORTS[manifest["edition"]]
    address = f"http://127.0.0.1:{port}"
    try:
        with create_connection(("127.0.0.1", port), timeout=0.25):
            raise RuntimeError(f"Portable verification port already in use: {port}")
    except OSError:
        pass
    env = clean_environment(local)
    with tempfile.TemporaryDirectory(prefix="VoxFigura execution ") as directory:
        launch = [str(exe)] if exe else [str(stage / "runtime/node/node.exe"), str(stage / "server/portable.mjs")]
        launcher = subprocess.Popen([*launch, "--no-browser"], cwd=directory, env=env,
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        log_lines = deque(maxlen=100)
        ready = Event()

        def read_console() -> None:
            with launcher.stdout as stdout:
                for raw in stdout:
                    line = raw.decode("utf-8", errors="replace")
                    log_lines.append(line)
                    if f"VoxFigura: {address}" in line:
                        ready.set()

        reader = Thread(target=read_console, daemon=True)
        reader.start()
        engine_port = None
        try:
            deadline = monotonic() + 55
            while True:
                require(launcher.poll() is None and monotonic() < deadline, "Portable launcher did not start")
                try:
                    if not ready.wait(0.25):
                        continue
                    health = json.loads(get_http(address, "/api/health"))
                    engine_port = int(health["engine_url"].rsplit(":", 1)[-1])
                    break
                except (URLError, TimeoutError):
                    sleep(0.25)
            get_http(health["engine_url"], "/health", status=403)
            result = check_features(address, stage, speech, full_library)
        except Exception:
            print("".join(list(log_lines))[-10000:])
            raise
        finally:
            if launcher.poll() is None:
                launcher.terminate()
                launcher.wait(timeout=10)
            reader.join(timeout=12)
            require(not reader.is_alive(), "A launched process retained the execution console after shutdown")
            if engine_port is not None:
                deadline = monotonic() + 8
                for launched_port in (port, engine_port):
                    while True:
                        try:
                            with create_connection(("127.0.0.1", launched_port), timeout=0.25):
                                pass
                        except OSError:
                            break
                        require(monotonic() < deadline, f"Portable port {launched_port} survived launcher exit")
                        sleep(0.25)
    return {"edition": manifest["edition"], "file_count": len(manifest["files"]), **result}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package", type=Path)
    parser.add_argument("--zh-speech", type=Path, required=True)
    parser.add_argument("--en-speech", type=Path, required=True)
    parser.add_argument("--zh-text", required=True)
    parser.add_argument("--en-text", required=True)
    parser.add_argument("--full-library", action="store_true", help="build and validate the complete IPA/VoQS audio archive")
    args = parser.parse_args()
    with extracted(args.package.resolve()) as (stage, exe, local):
        speech = {"zh": (args.zh_speech.resolve(), args.zh_text), "en": (args.en_speech.resolve(), args.en_text)}
        print(json.dumps(run(stage, speech, exe, local, args.full_library), ensure_ascii=False, indent=2))
