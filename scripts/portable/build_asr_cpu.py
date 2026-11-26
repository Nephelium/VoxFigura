"""Build the pinned Windows CPU-only CTranslate2 wheel for the portable package."""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys
import sysconfig

from build import DOWNLOADS, SCRIPTS, get_input, json_file, save_json, sha256


CT2_COMMIT = "617405f4b050e994e829d527da6caa0e0030afe7"
SUBMODULES = {
    "third_party/cpu_features": "8a494eb1e158ec2050e5f699a504fbc9b896a43b",
    "third_party/spdlog": "76fb40d95455f249bd70824ecfcae7a8f0930fa3",
    "third_party/ruy": "363f252289fb7a1fba1703d99196524698cb884d",
    "third_party/ruy/third_party/cpuinfo": "082deffc80ce517f81dc2f3aebe6ba671fcd09c9",
}
CPU_FLAGS = {
    "WITH_CUDA": "OFF", "WITH_CUDNN": "OFF", "WITH_MKL": "OFF", "WITH_DNNL": "OFF",
    "WITH_RUY": "ON", "OPENMP_RUNTIME": "NONE", "BUILD_CLI": "OFF", "BUILD_TESTS": "OFF",
}
SOURCE_URL = "https://github.com/OpenNMT/CTranslate2.git"
WHEEL_NAME = "ctranslate2-4.6.0-cp311-cp311-win_amd64.whl"


def git(directory: Path, *args: str) -> str:
    return subprocess.check_output(["git", "-C", str(directory), *args], text=True).strip()


def prepare_source(source: Path, offline: bool) -> None:
    if not source.is_dir():
        if offline:
            raise RuntimeError(f"Missing pinned CTranslate2 source: {source}")
        subprocess.run(["git", "clone", "--depth", "1", "--branch", "v4.6.0", SOURCE_URL, str(source)], check=True)
    if git(source, "rev-parse", "HEAD") != CT2_COMMIT:
        raise RuntimeError("CTranslate2 source revision mismatch")
    if not offline:
        subprocess.run(["git", "-C", str(source), "submodule", "update", "--init", "--recursive", "--depth", "1",
                        *list(SUBMODULES)[:3]], check=True)
    for name, revision in {"": CT2_COMMIT, **SUBMODULES}.items():
        directory = source / name
        if git(directory, "rev-parse", "HEAD") != revision or git(directory, "status", "--porcelain", "--untracked-files=no"):
            raise RuntimeError(f"Unpinned or changed CTranslate2 build source: {directory}")


def find_msvc() -> Path:
    tools = Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "Microsoft Visual Studio/Installer/vswhere.exe"
    base = subprocess.check_output([str(tools), "-latest", "-products", "*", "-version", "[17.0,18.0)",
                                    "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
                                    "-property", "installationPath"], text=True).strip()
    if not base:
        raise RuntimeError("A local Visual Studio 2022 x64 Build Tools installation is required")
    return Path(base)


def main(offline: bool) -> None:
    if sys.version_info[:2] != (3, 11) or sysconfig.get_platform() != "win-amd64":
        raise RuntimeError("CTranslate2 build requires CPython 3.11 x64 on Windows")
    DOWNLOADS.mkdir(parents=True, exist_ok=True)
    source = DOWNLOADS / "ct2-cpu-src"
    prepare_source(source, offline)
    lock = json_file(SCRIPTS / "inputs.lock.json")
    cache = DOWNLOADS / "ct2-build-wheels"
    wheel_inputs = [get_input(spec, offline, cache) for spec in lock["asr_build_wheels"]]

    msvc = find_msvc()
    cmake = msvc / "Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe"
    work = DOWNLOADS / "ct2-cpu-native"
    build = work / "cmake-win-amd64"
    prefix = work / "install"
    env = {**os.environ, "PROCESSOR_ARCHITECTURE": "AMD64", "PYTHONUTF8": "1",
           "CL": "/MP5 /utf-8", "CMAKE_BUILD_PARALLEL_LEVEL": "8", "CTRANSLATE2_ROOT": str(prefix)}
    subprocess.run([str(cmake), "-S", str(source), "-B", str(build), "-G", "Visual Studio 17 2022", "-A", "x64",
                    f"-DCMAKE_GENERATOR_INSTANCE={msvc}", f"-DCMAKE_INSTALL_PREFIX={prefix}",
                    *(f"-D{key}={value}" for key, value in CPU_FLAGS.items())], env=env, check=True)
    subprocess.run([str(cmake), "--build", str(build), "--config", "Release", "--target", "INSTALL", "--parallel", "8"],
                   env=env, check=True)

    venv = work / "venv"
    python = venv / "Scripts/python.exe"
    if not python.is_file():
        subprocess.run([sys.executable, "-m", "venv", str(venv)], check=True)
    subprocess.run([str(python), "-m", "pip", "install", "--no-index", "--no-deps", "--no-compile",
                    *(str(path) for path in wheel_inputs)], env=env, check=True)
    output = DOWNLOADS / "ctranslate2-cpu"
    output.mkdir(exist_ok=True)
    python_src = source / "python"
    shutil.copyfile(source / "LICENSE", python_src / "LICENSE")
    shutil.copyfile(prefix / "bin/ctranslate2.dll", python_src / "ctranslate2/ctranslate2.dll")
    subprocess.run([str(python), "setup.py", "bdist_wheel", "--dist-dir", str(output)], cwd=python_src, env=env, check=True)
    wheel = output / WHEEL_NAME
    licenses = {
        "CTranslate2-LICENSE.txt": source / "LICENSE",
        "ruy-LICENSE.txt": source / "third_party/ruy/LICENSE",
        "cpuinfo-LICENSE.txt": source / "third_party/ruy/third_party/cpuinfo/LICENSE",
        "cpu_features-LICENSE.txt": source / "third_party/cpu_features/LICENSE",
        "spdlog-LICENSE.txt": source / "third_party/spdlog/LICENSE",
    }
    for name, license_file in licenses.items():
        shutil.copyfile(license_file, output / name)
    save_json(output / "build.json", {
        "source": SOURCE_URL, "commit": CT2_COMMIT, "submodules": SUBMODULES,
        "compiler": "MSVC x64", "target": "Release", "cmake": CPU_FLAGS,
        "files": {name: sha256(output / name) for name in (WHEEL_NAME, *licenses)},
    })
    print(f"CPU_WHEEL={wheel}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--offline", action="store_true")
    main(parser.parse_args().offline)
