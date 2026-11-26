"""VoxFigura Local Python VTL 2.4 + VoxFigura Core HTTP Server.

Listens on 127.0.0.1:8765 using standard-library ThreadingHTTPServer.
VTL 2.4 and PyTorch M27 are lazily isolated so VTL routes start immediately.
"""
from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
from hmac import compare_digest
import shutil
import socket
import sys
from threading import Thread
import traceback
from typing import Any, Dict, Optional, Tuple
from urllib.parse import parse_qs, urlparse

# Adaptive CPU thread ceiling matching heavy ONNX models without oversubscribing hybrid cores.
_AUTO_CPU_THREADS = str(min(8, max(2, (os.cpu_count() or 4) // 2)))
os.environ.setdefault("OMP_NUM_THREADS", _AUTO_CPU_THREADS)
os.environ.setdefault("MKL_NUM_THREADS", _AUTO_CPU_THREADS)
ENGINE_DIR = Path(__file__).resolve().parent
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))

from dense_channel import DenseEngineManager  # noqa: E402
from keyframe_lite import AnnotationControlError, apply_annotation_trajectory  # noqa: E402
from m27_bridge import M27Bridge, TT3_ROOT  # noqa: E402
from model_registry_runtime import (  # noqa: E402
    LOCAL_MODEL_MANAGER,
    ModelContractError,
    ModelUnloadedError,
)
from prosody_bridge import ProsodyBridge  # noqa: E402
from realtime_m27 import RealtimeM27Service  # noqa: E402
import ipa_reference_library  # noqa: E402
from voice_morph_bridge import VoiceMorphBridge  # noqa: E402

DENSE_MANAGER = DenseEngineManager()
M27_BRIDGE = M27Bridge(DENSE_MANAGER)
PROSODY_BRIDGE = ProsodyBridge()
REALTIME_M27 = RealtimeM27Service(DENSE_MANAGER, M27_BRIDGE)
VOICE_MORPH_BRIDGE = VoiceMorphBridge(M27_BRIDGE)
LOCAL_ASR_ENABLED = os.environ.get("VOCALCUT_DISABLE_LOCAL_ASR") != "1"
if LOCAL_ASR_ENABLED:
    from asr_install import AsrInstallJob
    from asr_models import LEGACY_MODEL, MODELS, default_local_model, is_installed
    from speech_to_text import OfflineTranscriber, TranscriptionError

    OFFLINE_TRANSCRIBER = OfflineTranscriber()
    ASR_INSTALL = AsrInstallJob()


def asr_install_status(name: str | None = None) -> dict[str, Any]:
    job = ASR_INSTALL.status()
    model = name or default_local_model()
    custom = bool(os.environ.get("VOCALCUT_ASR_MODEL_DIR"))
    choices = [] if custom else [
        {"id": key, "size_bytes": spec.size_bytes, "installed": is_installed(key)} for key, spec in MODELS.items()
    ]
    if not custom and is_installed(LEGACY_MODEL):
        choices.append({"id": LEGACY_MODEL, "size_bytes": 0, "installed": True})
    status: dict[str, Any] = {"model": model, "models": choices}
    if job.get("state") == "installing":
        status["installing_model"] = job["model"]
    if job.get("model") == model and job.get("state") == "installing":
        return {**status, **job}
    offline = OFFLINE_TRANSCRIBER.status(model)
    available = custom or any(choice["id"] == model and choice["installed"] for choice in choices)
    if offline["ready"] and available:
        return {**status, "state": "ready"}
    if job.get("model") == model and job.get("state") == "failed":
        return {**status, **job}
    return {**status, "state": "missing", "hint": offline.get("hint")}

RESERVED_MODEL_CONTRACTS: Dict[str, Dict[str, Any]] = {
    "/models/browser-light-m27": {
        "ok": False,
        "status": "reserved_slot",
        "slot": "BrowserLightM27Slot",
        "model_id": "BrowserLightInverter",
        "fallback": "fallback_vox2tract",
        "contract": {
            "inputs": ["wav_16k (B, T*320)"],
            "frontend": "PureLogMel50Hz (80 log-mel + 80 delta + 3 energy = 163 dims)",
            "outputs": ["m21_norm_50hz (B, T, 21) -> [m20, PR]"],
            "reference": "model_bundle/src/tt3/browser_m27_models.py",
        },
        "hint": "浏览器内 ONNX 接口暂未接入。项目内 Vox2Tract-Lite 与 Vox2Align-Lite 通过 /m27/reconstruct 执行。",
    },
    "/models/speaker": {
        "ok": False,
        "status": "reserved_slot",
        "slot": "SpeakerModelSlot",
        "model_id": "CustomSpeakerWeights / FrozenSpeakerEncoder",
        "fallback": "tract2vox_zero_shot_vc",
        "contract": {
            "inputs": ["m27_50hz_pa", "speaker_ref_wav_base64"],
            "outputs": ["neural_16k_wav_base64"],
            "endpoint_ready": "/m27/resynthesize",
        },
        "hint": "Tract2Vox-Lite 默认使用井井的自然讲解声纹。POST /m27/resynthesize 可传 speaker_ref_wav_base64 指定参考音色。另行微调的权重保留独立接口。",
    },
}

MAX_BODY_BYTES = 64 * 1024 * 1024
_LOOPBACK_ORIGIN_RE = re.compile(r"^https?://(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$")


def scan_local_models() -> Dict[str, Any]:
    """Scan all 9 local ONNX models, hot-plug status, external mounts, byte sizes, and parameter counts."""
    return LOCAL_MODEL_MANAGER.list_status()


class PayloadTooLargeError(ValueError):
    """Raised when an HTTP request body exceeds MAX_BODY_BYTES."""


class VocalEngineHandler(BaseHTTPRequestHandler):
    def parse_request(self) -> bool:
        if not super().parse_request():
            return False
        token = os.environ.get("VOCALCUT_ENGINE_TOKEN")
        supplied = self.headers.get("X-VoxFigura-Engine-Token", "")
        if token and not compare_digest(token.encode(), supplied.encode()):
            self.send_error(403)
            return False
        return True

    protocol_version = "HTTP/1.1"

    def setup(self) -> None:
        self.timeout = 120.0
        super().setup()

    def handle(self) -> None:
        try:
            super().handle()
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError, TimeoutError, socket.timeout):
            pass

    def _allowed_origin(self) -> Optional[str]:
        origin = self.headers.get("Origin")
        if origin and _LOOPBACK_ORIGIN_RE.fullmatch(origin.strip()):
            return origin.strip()
        return None

    def _cors_headers(self) -> None:
        origin = self._allowed_origin()
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def log_message(self, format: str, *args: Any) -> None:
        # Suppress verbose noisy logs; emit concise structured stderr line
        sys.stderr.write(f"[engine] {self.command} {self.path} -> {args[1] if len(args) > 1 else ''}\n")

    def _send_json(self, status: int, data: Dict[str, Any]) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self._send_bytes(status, body, "application/json; charset=utf-8")

    def _send_bytes(self, status: int, body: bytes, content_type: str, cors: bool = True) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        origin = self._allowed_origin() if cors else None
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
        if not cors:
            self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_exact_body(self) -> bytes:
        try:
            length = int(self.headers.get("Content-Length", "0") or 0)
        except ValueError as exc:
            raise ValueError("Content-Length 请求头无效") from exc
        if length < 0:
            raise ValueError("Content-Length 不能为负数")
        if length > MAX_BODY_BYTES:
            raise PayloadTooLargeError(f"请求体大小 ({length} B) 超过 {MAX_BODY_BYTES // (1024 * 1024)} MiB 上限")
        if length == 0:
            return b""
        raw = self.rfile.read(length)
        if len(raw) != length:
            raise ValueError("客户端提前断开，请求体不完整")
        return raw

    def _read_json(self) -> Dict[str, Any]:
        raw = self._read_exact_body()
        if not raw:
            return {}
        parsed = json.loads(raw.decode("utf-8"))
        if not isinstance(parsed, dict):
            raise ValueError("JSON 请求体须为对象")
        return parsed

    def _send_ipa_library_file(self, path: Path, video: bool) -> None:
        filename = "vocalcut-ipa-voqs-library" + ("-with-glottis" if video else "") + ".zip"
        with path.open("rb") as archive:
            self.send_response(200)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Content-Length", str(os.fstat(archive.fileno()).st_size))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
            self.end_headers()
            try:
                shutil.copyfileobj(archive, self.wfile, length=1024 * 1024)
            except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
                pass

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        origin = self._allowed_origin()
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/models/voice-morph":
            try:
                self._send_json(200, VOICE_MORPH_BRIDGE.metadata())
            except (ValueError, FileNotFoundError, ImportError, RuntimeError) as error:
                self._send_json(503, {"ok": False, "hint": str(error)})
            return

        if path == "/m27/asr-install" and LOCAL_ASR_ENABLED:
            name = parse_qs(parsed.query).get("model", [None])[0]
            if name is not None and name not in (*MODELS, LEGACY_MODEL):
                self._send_json(400, {"hint": "请选择可用的本地 Whisper 模型"})
                return
            self._send_json(200, asr_install_status(name))
            return

        if path == "/models/ipa-recording-edits/limits":
            from ipa_recording_edits import edit_limits

            self._send_json(200, {"ok": True, **edit_limits(M27_BRIDGE)})
            return

        if path in ("/models/ipa-references/library-bundle", "/models/ipa-references/library-bundle/download"):
            import ipa_library_bundle

            query = parse_qs(parsed.query)
            option = query.get("video", ["0"])[0]
            audio_gain = query.get("audio_gain", ["peak"])[0]
            if option not in ("0", "1"):
                self._send_json(400, {"ok": False, "hint": "video 应为 0 或 1"})
                return
            if audio_gain not in ("peak", "original"):
                self._send_json(400, {"ok": False, "hint": "音量模式应为自动增益或原始电平"})
                return
            video = option == "1"
            if path.endswith("/download"):
                archive, data = ipa_library_bundle.download(video, audio_gain=audio_gain)
                if archive is None:
                    self._send_json(409, {**data, "hint": data.get("hint", "全库资料包尚未生成")})
                else:
                    try:
                        self._send_ipa_library_file(archive, video)
                    except FileNotFoundError:
                        self._send_json(404, {"ok": False, "hint": "资料包本地缓存已移除，请重新生成"})
            else:
                data = json.dumps(ipa_library_bundle.status(video, audio_gain=audio_gain), ensure_ascii=False).encode("utf-8")
                self._send_bytes(200, data, "application/json; charset=utf-8", cors=False)
            return

        if path == "/models/local":
            self._send_json(200, scan_local_models())
            return

        if path == "/models/ipa-references/poses":
            body = json.dumps({"ok": True, "poses": ipa_reference_library.poses()}, ensure_ascii=False).encode("utf-8")
            self._send_bytes(200, body, "application/json; charset=utf-8", cors=False)
            return

        if path == "/models/ipa-references/vowel-formants":
            query = parse_qs(parsed.query)
            source = query.get("source", ["recorded"])[0]
            if source == "recorded":
                self._send_json(200, ipa_reference_library.playback_measurements(ipa_reference_library.vowel_formants()))
            elif source == "transfer":
                from vowel_response import measures
                speaker = query.get("speaker", ["JD2"])[0]
                try:
                    data = measures(ipa_reference_library.index(), ipa_reference_library.LIBRARY, speaker)
                    self._send_json(200, ipa_reference_library.playback_measurements(data))
                except ValueError as error:
                    self._send_json(400, {"ok": False, "hint": str(error)})
                except (OSError, RuntimeError) as error:
                    self._send_json(503, {"ok": False, "hint": "VTL 元音参考测量未完成：" + str(error)})
            else:
                self._send_json(400, {"ok": False, "hint": "source 应为 transfer 或 recorded"})
            return

        if path == "/models/ipa-references/trill-demos":
            body = json.dumps({"ok": True, "records": ipa_reference_library.trill_demos()}, ensure_ascii=False).encode("utf-8")
            self._send_bytes(200, body, "application/json; charset=utf-8", cors=False)
            return

        if path.endswith(("/voqs-track", "/voqs-reconstruction")):
            from voqs_reference import ROUTE, track, reconstruction
            match = ROUTE.fullmatch(path)
            if match is not None:
                identifier, resource = match.groups()
                query = parse_qs(parsed.query)
                try:
                    if resource == "voqs-track":
                        result = track(identifier)
                        if result is not None:
                            self._send_bytes(200, json.dumps(result, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8", cors=False)
                            return
                    else:
                        audio_gain = query.get("audio_gain", ["peak"])[0]
                        if audio_gain not in ("peak", "original"):
                            self._send_json(400, {"ok": False, "hint": "音量模式应为自动增益或原始电平"})
                            return
                        wav = reconstruction(
                            identifier, DENSE_MANAGER, query.get("speaker", ["JD2"])[0],
                            query.get("height_cm", [None])[0], audio_gain=audio_gain,
                        )
                        if wav is not None:
                            self._send_bytes(200, wav, "audio/wav", cors=False)
                            return
                    self._send_json(404, {"ok": False, "hint": "此 VoQS 实录暂无 50 Hz 声门轨"})
                except (ValueError, TypeError, KeyError) as error:
                    self._send_json(400, {"ok": False, "hint": str(error)})
                except (OSError, RuntimeError) as error:
                    self._send_json(503, {"ok": False, "hint": "本机未完成 VoQS 声门渲染：" + str(error)})
                return

        ipa_resource = ipa_reference_library.REFERENCE_ROUTE.fullmatch(path)
        if path == "/models/ipa-references/index" or ipa_resource:
            if ipa_resource:
                audio_gain = parse_qs(parsed.query).get("audio_gain", ["peak"])[0]
                if audio_gain not in ("peak", "original"):
                    self._send_json(400, {"ok": False, "hint": "音量模式应为自动增益或原始电平"})
                    return
                try:
                    data = ipa_reference_library.load_resource(*ipa_resource.groups(), M27_BRIDGE, audio_gain=audio_gain)
                except (OSError, RuntimeError, ValueError) as error:
                    self._send_json(503, {"ok": False, "hint": f"本机 Tract2Vox-Lite 未完成重合成：{error}"})
                    return
                if data is None:
                    self._send_json(404, {"ok": False, "hint": "本机没有该录音或重建轨迹"})
                else:
                    self._send_bytes(200, *data, cors=False)
            else:
                body = json.dumps({"ok": True, "records": ipa_reference_library.playback_index()}, ensure_ascii=False).encode("utf-8")
                self._send_bytes(200, body, "application/json; charset=utf-8", cors=False)
            return

        if path == "/health":
            self._send_json(
                200,
                {
                    "ok": True,
                    "service": "vocalcut-engine",
                    "vtl": DENSE_MANAGER.status(),
                    "m27": M27_BRIDGE.probe_status(),
                    "speech_to_text": OFFLINE_TRANSCRIBER.status() if LOCAL_ASR_ENABLED else {"ready": False, "enabled": False},
                    "reserved_slots": {
                        "kf2tract": {"status": "local_lite", "model": "IPA2Tract-Lite"},
                        "browser_light_m27": {"status": "local_lite", "endpoint": "/m27/reconstruct"},
                        "speaker": {"status": "ready_zero_shot_vc", "default_profile": "jingjing-lecture", "custom_weights": "untrained_slot"},
                    },
                },
            )
            return

        if path == "/vtl/meta":
            qs = parse_qs(parsed.query)
            speaker = qs.get("speaker", ["JD2"])[0]
            try:
                meta = DENSE_MANAGER.metadata(speaker)
                self._send_json(200, meta)
            except ValueError as exc:
                self._send_json(400, {"ok": False, "error": {"code": "validation_error", "hint": str(exc)}})
            return

        if path == "/models/kf2tract":
            ready = LOCAL_MODEL_MANAGER.is_enabled("IPA2Tract-Lite") and LOCAL_MODEL_MANAGER.active_path("IPA2Tract-Lite").is_file()
            self._send_json(200, {"weights_ready": ready, "model": "IPA2Tract-Lite"})
            return

        if path in RESERVED_MODEL_CONTRACTS:
            self._send_json(501, RESERVED_MODEL_CONTRACTS[path])
            return

        self._send_json(404, {"ok": False, "error": {"code": "not_found", "hint": f"Unknown GET path: {path}"}})

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/models/local/mount-binary":
            try:
                query = parse_qs(parsed.query)
                slot_name = (query.get("name", [""])[0] or "").strip()
                filename = (query.get("filename", ["custom.onnx"])[0] or "custom.onnx").strip()
                raw = self._read_exact_body()
                if slot_name:
                    slot_state = LOCAL_MODEL_MANAGER.mount_external_bytes(slot_name, filename, raw)
                else:
                    slot_state = LOCAL_MODEL_MANAGER.mount_external_bytes_auto(filename, raw)
                self._send_json(200, {"ok": True, "model": slot_state, "models_state": LOCAL_MODEL_MANAGER.list_status()})
            except PayloadTooLargeError as exc:
                self._send_json(413, {"ok": False, "hint": str(exc), "error": {"code": "payload_too_large", "hint": str(exc)}})
            except (ModelContractError, ValueError) as exc:
                self._send_json(400, {"ok": False, "hint": str(exc), "error": {"code": "model_contract_error", "hint": str(exc)}})
            except Exception as exc:
                self._send_json(500, {"ok": False, "hint": f"装载外置 ONNX 模型失败：{exc}"})
            return

        if path == "/models/dpdfnet":
            try:
                from dpdf_audio import denoise
                audio_gain = parse_qs(parsed.query).get("audio_gain", ["peak"])[0]
                if audio_gain not in ("peak", "original"):
                    self._send_json(400, {"ok": False, "hint": "音量模式应为自动增益或原始电平"})
                    return
                raw = self._read_exact_body()
                if len(raw) < 44:
                    raise ValueError("缺少 WAV 音频")
                self._send_bytes(200, denoise(raw, audio_gain=audio_gain), "audio/wav")
            except PayloadTooLargeError as exc:
                self._send_json(413, {"ok": False, "error": {"code": "payload_too_large", "hint": str(exc)}})
            except ModelUnloadedError as exc:
                self._send_json(503, {"ok": False, "hint": exc.hint, "error": {"code": exc.code, "model": exc.model_name, "hint": exc.hint}})
            except FileNotFoundError:
                self._send_json(503, {"hint": "本机 DPDFNet 模型或 PhoneticToolbox 组件不可用"})
            except Exception as exc:
                self._send_json(400, {"hint": "DPDFNet 未能处理音频：" + str(exc)})
            return

        if path in RESERVED_MODEL_CONTRACTS:
            self._send_json(501, RESERVED_MODEL_CONTRACTS[path])
            return

        try:
            payload = self._read_json()
        except PayloadTooLargeError as exc:
            self._send_json(413, {"ok": False, "error": {"code": "payload_too_large", "hint": str(exc)}})
            return
        except Exception as exc:
            self._send_json(400, {"ok": False, "error": {"code": "validation_error", "hint": f"JSON 解析失败: {exc}"}})
            return

        if isinstance(payload, dict) and "audio_gain" in payload and payload["audio_gain"] not in ("peak", "original"):
            self._send_json(400, {"ok": False, "error": {"code": "validation_error", "field": "audio_gain",
                                                      "hint": "音量模式应为自动增益或原始电平"}})
            return

        try:
            if path == "/models/local/load":
                try:
                    dev = str(payload.get("device") or "cpu")
                    if payload.get("all") is True:
                        self._send_json(200, LOCAL_MODEL_MANAGER.load_all(device=dev))
                    else:
                        name = str(payload.get("name") or "").strip()
                        if not name:
                            raise ValueError("请指定要装载的模型名称")
                        slot_state = LOCAL_MODEL_MANAGER.load_model(name, device=dev)
                        self._send_json(200, {"ok": True, "model": slot_state, "models_state": LOCAL_MODEL_MANAGER.list_status()})
                except (ValueError, ModelContractError) as exc:
                    self._send_json(400, {"ok": False, "hint": str(exc), "error": {"code": "validation_error", "hint": str(exc)}})
                except FileNotFoundError as exc:
                    self._send_json(404, {"ok": False, "hint": str(exc), "error": {"code": "model_unavailable", "hint": str(exc)}})
                return

            if path == "/models/local/unload":
                try:
                    if payload.get("all") is True:
                        self._send_json(200, LOCAL_MODEL_MANAGER.unload_all())
                    else:
                        name = str(payload.get("name") or "").strip()
                        if not name:
                            raise ValueError("请指定要卸载的模型名称")
                        slot_state = LOCAL_MODEL_MANAGER.unload_model(name)
                        self._send_json(200, {"ok": True, "model": slot_state, "models_state": LOCAL_MODEL_MANAGER.list_status()})
                except ValueError as exc:
                    self._send_json(400, {"ok": False, "hint": str(exc), "error": {"code": "validation_error", "hint": str(exc)}})
                return

            if path == "/models/local/mount":
                try:
                    folder = payload.get("folder")
                    if isinstance(folder, str) and folder.strip():
                        do_mount = payload.get("mount", True) is not False
                        res = LOCAL_MODEL_MANAGER.scan_and_mount_folder(folder.strip(), mount=do_mount)
                        self._send_json(200, res)
                        return
                    name = str(payload.get("name") or "").strip()
                    file_path = payload.get("path")
                    if isinstance(file_path, str) and file_path.strip():
                        if not name:
                            slot, err = LOCAL_MODEL_MANAGER.detect_slot_for_onnx(Path(file_path.strip()).expanduser())
                            if slot is None:
                                raise ModelContractError(err or "无法匹配该 ONNX 模型到内置槽位")
                            name = slot.name
                        slot_state = LOCAL_MODEL_MANAGER.mount_external_file(
                            name, file_path.strip(), label=payload.get("label") if isinstance(payload.get("label"), str) else None
                        )
                        self._send_json(200, {"ok": True, "model": slot_state, "models_state": LOCAL_MODEL_MANAGER.list_status()})
                        return
                    raise ValueError("请提供 folder 目录路径或 path 模型文件路径")
                except (ValueError, ModelContractError) as exc:
                    self._send_json(400, {"ok": False, "hint": str(exc), "error": {"code": "model_contract_error", "hint": str(exc)}})
                except FileNotFoundError as exc:
                    self._send_json(404, {"ok": False, "hint": str(exc), "error": {"code": "not_found", "hint": str(exc)}})
                return

            if path == "/models/local/reset":
                try:
                    if payload.get("all") is True:
                        self._send_json(200, LOCAL_MODEL_MANAGER.reset_all())
                    else:
                        name = str(payload.get("name") or "").strip()
                        if not name:
                            raise ValueError("请指定要恢复内置默认的模型名称")
                        slot_state = LOCAL_MODEL_MANAGER.reset_model(name)
                        self._send_json(200, {"ok": True, "model": slot_state, "models_state": LOCAL_MODEL_MANAGER.list_status()})
                except ValueError as exc:
                    self._send_json(400, {"ok": False, "hint": str(exc), "error": {"code": "validation_error", "hint": str(exc)}})
                return

            if path == "/m27/asr-install" and LOCAL_ASR_ENABLED:
                name = payload.get("model")
                if self.headers.get_content_type() != "application/json" or not isinstance(name, str) or name not in (*MODELS, LEGACY_MODEL):
                    self._send_json(400, {"hint": "请选择要下载的 Whisper 模型"})
                    return
                offline = asr_install_status(name)
                if offline["state"] == "ready":
                    self._send_json(200, offline)
                    return
                if os.environ.get("VOCALCUT_ASR_MODEL_DIR") or (name == LEGACY_MODEL and not is_installed(name)):
                    self._send_json(400, {"hint": "请检查本地模型和运行库配置"})
                    return
                job = ASR_INSTALL.start(name)
                if job["model"] != name:
                    self._send_json(409, {"hint": "另一款 Whisper 模型正在下载，请等待完成"})
                    return
                self._send_json(202, asr_install_status(name))
                return

            if path == "/models/ipa-references/library-bundle":
                import ipa_library_bundle

                video = payload.get("include_video", False) if isinstance(payload, dict) else None
                retry = payload.get("retry_missing", False) if isinstance(payload, dict) else None
                audio_gain = payload.get("audio_gain", "peak") if isinstance(payload, dict) else "peak"
                if type(video) is not bool or type(retry) is not bool:
                    self._send_json(400, {"ok": False, "hint": "导出开关应为布尔值"})
                    return
                state = ipa_library_bundle.start(video, M27_BRIDGE, retry, audio_gain=audio_gain)
                data = json.dumps(state, ensure_ascii=False).encode("utf-8")
                self._send_bytes(202 if state["state"] == "building" else 200, data, "application/json; charset=utf-8", cors=False)
                return
            if path == "/models/ipa-recording-edits/render":
                from ipa_recording_edits import FrameEditError, render_revision

                try:
                    result = render_revision(payload, M27_BRIDGE)
                    self._send_json(200 if result.get("ok") else 400, result)
                except FrameEditError as exc:
                    self._send_json(400, {"ok": False, "error": exc.detail})
                return
            if path == "/models/ipa-references/vowel-poses":
                from vowel_response import measure_saved_poses
                try:
                    self._send_json(200, measure_saved_poses(payload.get("speaker"), payload.get("poses"), dense_manager=DENSE_MANAGER))
                except (ValueError, TypeError) as error:
                    self._send_json(400, {"ok": False, "hint": str(error)})
                return
            if path == "/models/ipa-default-poses":
                from keyframe_lite import default_poses
                try:
                    self._send_json(200, default_poses(payload))
                except ValueError as error:
                    self._send_json(400, {"ok": False, "hint": str(error)})
                except (FileNotFoundError, ImportError):
                    self._send_json(503, {"ok": False, "hint": "IPA2Tract-Lite 默认构型库不可用"})
                return

            if path == "/models/kf2tract":
                from keyframe_lite import predict
                try:
                    self._send_json(200, predict(payload))
                except AnnotationControlError as error:
                    self._send_json(400, error.result)
                except ModelUnloadedError as exc:
                    self._send_json(503, {"ok": False, "hint": exc.hint, "error": {"code": exc.code, "model": exc.model_name, "hint": exc.hint}})
                except (TypeError, ValueError) as exc:
                    self._send_json(400, {"ok": False, "error": {"code": "validation_error", "hint": str(exc)}})
                return
            if path == "/models/voice-transfer":
                try:
                    self._send_json(200, VOICE_MORPH_BRIDGE.render(payload))
                except AnnotationControlError as error:
                    self._send_json(400, error.result)
                except ModelUnloadedError as exc:
                    self._send_json(503, {"ok": False, "hint": exc.hint, "error": {"code": exc.code, "model": exc.model_name, "hint": exc.hint}})
                except (ValueError, FileNotFoundError, RuntimeError) as error:
                    self._send_json(400, {"ok": False, "hint": str(error)})
                return

            if path == "/models/voice-morph":
                try:
                    self._send_json(200, VOICE_MORPH_BRIDGE.dispatch(payload))
                except AnnotationControlError as error:
                    self._send_json(400, error.result)
                except ModelUnloadedError as exc:
                    self._send_json(503, {"ok": False, "hint": exc.hint, "error": {"code": exc.code, "model": exc.model_name, "hint": exc.hint}})
                except ValueError as error:
                    self._send_json(400, {"ok": False, "hint": str(error)})
                except (FileNotFoundError, ImportError, RuntimeError) as error:
                    self._send_json(503, {"ok": False, "hint": str(error)})
                return

            if path == "/models/text-prosody":
                try:
                    self._send_json(200, PROSODY_BRIDGE.predict(payload))
                except ModelUnloadedError as exc:
                    self._send_json(503, {"ok": False, "hint": exc.hint, "error": {"code": exc.code, "model": exc.model_name, "hint": exc.hint}})
                except ValueError as exc:
                    self._send_json(400, {"ok": False, "error": {"code": "validation_error", "hint": str(exc)}})
                except (FileNotFoundError, ImportError):
                    self._send_json(503, {"ok": False, "error": {"code": "model_unavailable", "hint": "本机 Text2Prosody-Lite 模块或权重不可用"}})
                return

            if path == "/models/swift-f0":
                from swift_pitch import extract
                try:
                    self._send_json(200, extract(payload))
                except ModelUnloadedError as exc:
                    self._send_json(503, {"ok": False, "hint": exc.hint, "error": {"code": exc.code, "model": exc.model_name, "hint": exc.hint}})
                except (ValueError, KeyError, TypeError) as exc:
                    self._send_json(400, {"ok": False, "error": {"code": "validation_error", "hint": str(exc)}})
                except (FileNotFoundError, ImportError, RuntimeError) as exc:
                    self._send_json(503, {"ok": False, "error": {"code": "model_unavailable", "hint": str(exc)}})
                return

            if path == "/vtl/high-pitch-preview":
                try:
                    from high_pitch_preview import render_high_pitch_preview
                    res = render_high_pitch_preview(payload, DENSE_MANAGER)
                except (FileNotFoundError, ImportError):
                    self._send_json(503, {"ok": False, "error": {"code": "model_unavailable", "hint": "高音试听需要本机 VTL 2.4 与 JD2 资源"}})
                    return
                self._send_json(200 if res.get("ok") else 400, res)
                return

            if path == "/vtl/pose":
                res = DENSE_MANAGER.pose_snapshot(payload)
                self._send_json(200 if res.get("ok", True) else 400, res)
                return

            if path == "/vtl/live-pull":
                res = DENSE_MANAGER.live_pull(payload)
                self._send_json(200 if res.get("ok", True) else 400, res)
                return

            if path == "/vtl/synthesize-stream":
                mode = payload.get("synth_mode", "neural")
                if mode not in ("neural", "physical"):
                    self._send_json(400, {"ok": False, "error": {"code": "validation_error", "hint": "流式分段先播仅适用于 neural 或 physical 合成"}})
                    return
                articulation = {}
                predicted_rows = None
                try:
                    if payload.get("predict_articulation") and payload.get("articulation_spans"):
                        if payload.get("speaker") not in ("JD2", "JD2-2D"):
                            raise ValueError("IPA2Tract-Lite 协同构音使用 JD2 声道")
                        if LOCAL_MODEL_MANAGER.is_enabled("IPA2Tract-Lite"):
                            payload, predicted_rows, articulation = apply_annotation_trajectory(payload)
                            mode = payload.get("synth_mode", mode)
                        else:
                            articulation = {"articulation_model": None, "articulation_status": "unloaded_fallback"}
                    gen = (
                        M27_BRIDGE.synthesize_dense_neural_stream(payload, predicted_rows)
                        if mode == "neural"
                        else DENSE_MANAGER.synthesize_dense_stream(payload, predicted_rows)
                    )
                    first = next(gen, None)
                except AnnotationControlError as error:
                    self._send_json(400, error.result)
                    return
                except ModelUnloadedError as exc:
                    self._send_json(503, {"ok": False, "hint": exc.hint, "error": {"code": exc.code, "model": exc.model_name, "hint": exc.hint}})
                    return
                except (TypeError, KeyError, ValueError) as error:
                    self._send_json(400, {"ok": False, "error": {"code": "validation_error", "hint": str(error)}})
                    return
                except (FileNotFoundError, ImportError):
                    self._send_json(503, {"ok": False, "error": {"code": "model_unavailable", "hint": "Tract2Vox-Lite 本地权重不可用"}})
                    return

                if first is None or not first.get("ok"):
                    err_code = (first.get("error") or {}).get("code") if isinstance(first, dict) else None
                    status = 503 if err_code in ("model_unavailable", "model_unloaded") else 400
                    self._send_json(status, first or {"ok": False, "error": {"code": "validation_error", "hint": "流式合成未产生输出"}})
                    return

                first.update(articulation)
                self.send_response(200)
                self._cors_headers()
                self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Transfer-Encoding", "chunked")
                self.send_header("X-Accel-Buffering", "no")
                self.end_headers()

                def _emit_ndjson(obj: Dict[str, Any]) -> None:
                    line = (json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8")
                    self.wfile.write(f"{len(line):x}\r\n".encode("ascii"))
                    self.wfile.write(line)
                    self.wfile.write(b"\r\n")
                    self.wfile.flush()

                try:
                    _emit_ndjson(first)
                    for item in gen:
                        _emit_ndjson(item)
                    self.wfile.write(b"0\r\n\r\n")
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
                    pass
                return

            if path == "/vtl/synthesize":
                mode = payload.get("synth_mode", "physical")
                if mode not in ("physical", "neural"):
                    self._send_json(400, {"ok": False, "error": {"code": "validation_error", "hint": "音源应为 physical 或 neural"}})
                    return
                articulation = {}
                predicted_rows = None
                try:
                    if payload.get("predict_articulation") and payload.get("articulation_spans"):
                        if payload.get("speaker") not in ("JD2", "JD2-2D"):
                            raise ValueError("IPA2Tract-Lite 协同构音使用 JD2 声道")
                        if LOCAL_MODEL_MANAGER.is_enabled("IPA2Tract-Lite"):
                            payload, predicted_rows, articulation = apply_annotation_trajectory(payload)
                            mode = payload.get("synth_mode", mode)
                        else:
                            articulation = {"articulation_model": None, "articulation_status": "unloaded_fallback"}
                    res = M27_BRIDGE.synthesize_dense_neural(payload, predicted_rows) if mode == "neural" else DENSE_MANAGER.synthesize_dense(payload)
                except AnnotationControlError as error:
                    self._send_json(400, error.result)
                    return
                except ModelUnloadedError as exc:
                    self._send_json(503, {"ok": False, "hint": exc.hint, "error": {"code": exc.code, "model": exc.model_name, "hint": exc.hint}})
                    return
                except (TypeError, KeyError, ValueError) as error:
                    self._send_json(400, {"ok": False, "error": {"code": "validation_error", "hint": str(error)}})
                    return
                except (FileNotFoundError, ImportError):
                    self._send_json(503, {"ok": False, "error": {"code": "model_unavailable", "hint": "所选合成路径的本地权重或引擎不可用（IPA2Tract-Lite、Tract2Vox-Lite 或 VTL）"}})
                    return
                if mode == "physical" and res.get("ok"):
                    res.update(synth_mode="physical", device_effective="cpu", source_badge="VTL 2.4 物理声管")
                    if payload.get("return_control_track") and predicted_rows is not None and "m27_control_50hz_pa" not in res:
                        res["m27_control_50hz_pa"] = [
                            [float(v) / 10.0 if ci == 18 else float(v) for ci, v in enumerate(row)]
                            for row in predicted_rows
                        ]
                if res.get("ok"):
                    res.update(articulation)
                err_code = (res.get("error") or {}).get("code") if isinstance(res, dict) else None
                status = 200 if res.get("ok", True) else 503 if err_code in ("model_unavailable", "model_unloaded") else 400
                self._send_json(status, res)
                return

            if path == "/vtl/batch-contours":
                res = DENSE_MANAGER.batch_contours(payload)
                self._send_json(200 if res.get("ok", True) else 400, res)
                return

            if path == "/m27/extract-anim":
                res = M27_BRIDGE.extract_anim_from_pa(payload)
                self._send_json(200 if res.get("ok", True) else 400, res)
                return

            if path == "/m27/reconstruct":
                res = M27_BRIDGE.reconstruct(payload)
                err_code = (res.get("error") or {}).get("code") if isinstance(res, dict) else None
                status = 200 if res.get("ok", True) else 503 if err_code in ("model_unavailable", "model_unloaded") else 400
                self._send_json(status, res)
                return

            if path == "/m27/align":
                res = M27_BRIDGE.align(payload)
                err_code = (res.get("error") or {}).get("code") if isinstance(res, dict) else None
                status = 200 if res.get("ok") else 503 if err_code in ("model_unavailable", "model_unloaded") else 400
                self._send_json(status, res)
                return

            if path == "/m27/transcribe" and LOCAL_ASR_ENABLED:
                try:
                    self._send_json(200, OFFLINE_TRANSCRIBER.transcribe(payload))
                except TranscriptionError as error:
                    self._send_json(error.status, error.result)
                return

            if path == "/m27/resynthesize":
                res = M27_BRIDGE.resynthesize(payload)
                err_code = (res.get("error") or {}).get("code") if isinstance(res, dict) else None
                status = 200 if res.get("ok", True) else 503 if err_code in ("model_unavailable", "model_unloaded") else 400
                self._send_json(status, res)
                return

            if path == "/m27/realtime-speaker":
                res = REALTIME_M27.prepare_speaker(payload)
                err_code = (res.get("error") or {}).get("code") if isinstance(res, dict) else None
                status = 200 if res.get("ok") else 503 if err_code in ("model_unavailable", "model_unloaded") else 400
                self._send_json(status, res)
                return

            if path == "/m27/realtime-step":
                res = REALTIME_M27.step(payload)
                err_code = (res.get("error") or {}).get("code") if isinstance(res, dict) else None
                status = 200 if res.get("ok") else 503 if err_code in ("model_unavailable", "model_unloaded") else 400
                self._send_json(status, res)
                return

            if path == "/m27/hold-preview":
                try:
                    res = M27_BRIDGE.hold_preview(payload)
                except (FileNotFoundError, ImportError):
                    self._send_json(503, {"ok": False, "error": {"code": "model_unavailable", "hint": "Tract2Vox-Lite 或示例音色不可用"}})
                    return
                err_code = (res.get("error") or {}).get("code") if isinstance(res, dict) else None
                status = 200 if res.get("ok") else 503 if err_code in ("model_unavailable", "model_unloaded") else 400
                self._send_json(status, res)
                return

            self._send_json(404, {"ok": False, "error": {"code": "not_found", "hint": f"Unknown POST path: {path}"}})
        except Exception as exc:
            traceback.print_exc(file=sys.stderr)
            self._send_json(500, {"ok": False, "error": {"code": "validation_error", "hint": f"引擎内部错误: {exc}"}})


def main() -> None:
    host = os.environ.get("ENGINE_HOST", "127.0.0.1")
    port = int(os.environ.get("ENGINE_PORT", "8765"))
    server = ThreadingHTTPServer((host, port), VocalEngineHandler)
    print(f"VoxFigura Engine listening on http://{host}:{server.server_port}", flush=True)
    if os.environ.get("VOCALCUT_ENGINE_PARENT_PIPE") == "1":
        def stop_when_parent_exits() -> None:
            sys.stdin.buffer.read()
            server.shutdown()

        Thread(target=stop_when_parent_exits, daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
