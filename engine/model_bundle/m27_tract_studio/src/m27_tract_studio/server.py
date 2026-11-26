"""Standalone CORS-enabled HTTP server & CLI entrypoint for m27-tract-studio."""
from __future__ import annotations

import argparse
from collections import OrderedDict
from datetime import datetime
from email.parser import BytesParser
from email.policy import default as email_default_policy
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import mimetypes
import os
from pathlib import Path
import re
import threading
from typing import Any, Dict, Optional, Tuple
from urllib.parse import parse_qs, unquote, urlparse
import uuid

import numpy as np
import soundfile as sf

from .config import DEFAULT_TRAIN_ROOT, TractStudioConfig, find_web_dir, inspect_available_checkpoints
from .denoise import DENOISE_PRESETS, denoise_audio_bytes
from .engine import ALLOWED_EXTS, SAFE_JOB_RE, TractReconstructionEngine

SAFE_AUDIO_FILE_RE = re.compile(r"^[A-Za-z0-9_.\-]+\.(?:wav|npz|json)$")
THEME_CATALOG = (
    {"id": "ivory", "label": "学术纸白"},
    {"id": "midnight", "label": "深邃暗色"},
    {"id": "slate", "label": "科技蓝灰"},
    {"id": "rose", "label": "柔雾暖纸"},
)


def _wav_bytes_from_float32(wav_16k: np.ndarray, sr: int = 16000) -> bytes:
    from tt3.playback import normalize_playback

    buf = io.BytesIO()
    sf.write(buf, normalize_playback(wav_16k), int(sr), format="WAV", subtype="PCM_16")
    return buf.getvalue()


class TractStudioJobRunner:
    """Thread-safe background task coordinator & denoise preview cache for the web studio."""

    def __init__(self, engine: TractReconstructionEngine) -> None:
        self.engine = engine
        self._lock = threading.Lock()
        self._running = False
        self._active_job: Optional[str] = None
        self._active_name: Optional[str] = None
        self._progress_text: str = ""
        self._last_error: Optional[str] = None

        self._preview_lock = threading.Lock()
        self._previews: OrderedDict[str, Dict[str, Any]] = OrderedDict()

    def state(self) -> Dict[str, Any]:
        with self._lock:
            running = self._running
            active_job = self._active_job
            active_name = self._active_name
            progress_text = self._progress_text
            err = self._last_error
        return {
            "running": running,
            "active_job": active_job,
            "active_name": active_name,
            "progress_text": progress_text,
            "error": err,
            "history": self.engine.list_jobs(limit=100, url_prefix="/api/jobs"),
        }

    def create_denoise_preview(
        self,
        raw_bytes: bytes,
        *,
        filename: str = "upload.wav",
        preset: str = "standard",
    ) -> Dict[str, Any]:
        if not raw_bytes:
            raise ValueError("待降噪的音频内容为空")
        if len(raw_bytes) > self.engine.config.max_upload_bytes:
            raise ValueError("音频文件超过 50 MB 上限")
        clean_name = Path(filename or "upload.wav").name
        raw_16k, denoised_16k, metrics = denoise_audio_bytes(
            raw_bytes,
            filename=clean_name,
            preset=preset,
            max_duration_sec=self.engine.config.max_duration_sec,
        )
        raw_wav = _wav_bytes_from_float32(raw_16k, 16000)
        denoised_wav = _wav_bytes_from_float32(denoised_16k, 16000)

        pid = f"dn_{uuid.uuid4().hex[:10]}"
        ext = Path(clean_name).suffix.lower()
        if ext not in ALLOWED_EXTS:
            ext = ".wav"
        entry = {
            "preview_id": pid,
            "filename": clean_name,
            "ext": ext,
            "preset": metrics["preset"],
            "dur_sec": round(len(raw_16k) / 16000.0, 3),
            "metrics": metrics,
            "orig_bytes": raw_bytes,
            "raw_wav": raw_wav,
            "denoised_wav": denoised_wav,
        }
        with self._preview_lock:
            self._previews[pid] = entry
            self._previews.move_to_end(pid)
            while len(self._previews) > 16:
                self._previews.popitem(last=False)

        return {
            "ok": True,
            "preview_id": pid,
            "filename": clean_name,
            "preset": metrics["preset"],
            "dur_sec": entry["dur_sec"],
            "metrics": metrics,
            "raw_url": f"/api/denoise_preview/{pid}/raw.wav",
            "denoised_url": f"/api/denoise_preview/{pid}/denoised.wav",
            "download_url": f"/api/denoise_preview/{pid}/denoised.wav?download=1",
        }

    def get_preview_wav(self, preview_id: str, kind: str) -> Tuple[bytes, str]:
        with self._preview_lock:
            entry = self._previews.get(preview_id)
            if entry is None:
                raise FileNotFoundError(f"降噪预览已过期或不存在: {preview_id}")
            stem = Path(entry["filename"]).stem
            if kind == "raw.wav":
                return entry["raw_wav"], f"{stem}_raw16k.wav"
            if kind == "denoised.wav":
                return entry["denoised_wav"], f"{stem}_denoised_{entry['preset']}.wav"
            raise FileNotFoundError(f"未知音频类型: {kind}")

    def submit_reconstruct(
        self,
        raw_bytes: Optional[bytes],
        *,
        filename: str = "upload.wav",
        preview_id: Optional[str] = None,
        checkpoint: str = "neural_best",
        device: str = "cpu",
        denoise: bool = False,
        denoise_preset: str = "standard",
        spk_bytes: Optional[bytes] = None,
        spk_filename: str = "",
    ) -> Dict[str, Any]:
        if preview_id and not raw_bytes:
            with self._preview_lock:
                entry = self._previews.get(preview_id)
            if entry is None:
                raise FileNotFoundError(f"降噪预览不存在或已清理: {preview_id}")
            raw_bytes = entry["orig_bytes"]
            filename = entry["filename"]
            denoise_preset = denoise_preset or entry["preset"]

        if not raw_bytes:
            raise ValueError("上传的音频文件为空")
        if len(raw_bytes) > self.engine.config.max_upload_bytes:
            raise ValueError("上传文件超过 50 MB 上限")
        if spk_bytes and len(spk_bytes) > self.engine.config.max_upload_bytes:
            raise ValueError("目标说话人参考音频超过 50 MB 上限")

        clean_name = Path(filename or "upload.wav").name
        jid = f"{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}"

        with self._lock:
            if self._running:
                raise RuntimeError("上一条声道重构或批量重合成仍在处理中，请稍候完成")
            self._running = True
            self._active_job = jid
            self._active_name = clean_name
            self._progress_text = f"正在反演声道轨迹{'并降噪' if denoise else ''}..."
            self._last_error = None

        def _worker() -> None:
            err: Optional[str] = None
            try:
                self.engine.reconstruct_audio(
                    raw_bytes,
                    filename=clean_name,
                    checkpoint=checkpoint,
                    device=device,
                    denoise=denoise,
                    denoise_preset=denoise_preset,
                    speaker_ref=spk_bytes,
                    speaker_ref_filename=spk_filename,
                    job_id=jid,
                    url_prefix="/api/jobs",
                )
            except Exception as exc:
                err = str(exc)
            finally:
                with self._lock:
                    self._running = False
                    self._progress_text = ""
                    self._last_error = err

        threading.Thread(target=_worker, daemon=True).start()
        return {"started": True, "job_id": jid, "filename": clean_name, "denoised": bool(denoise)}

    def submit_resynth(
        self,
        *,
        checkpoint: str = "neural_best",
        device: str = "cpu",
        job_id: Optional[str] = None,
        denoise: Optional[bool] = None,
        denoise_preset: Optional[str] = None,
    ) -> Dict[str, Any]:
        target_jid = (job_id or "").strip() or None
        if target_jid is not None:
            # Verify target job exists before taking the lock
            self.engine.get_job(target_jid)
            label = f"重合成 {target_jid} ({checkpoint})"
        else:
            label = f"一键重合成全部历史 ({checkpoint})"

        with self._lock:
            if self._running:
                raise RuntimeError("上一条推理或批量重合成仍在处理中，请稍候")
            self._running = True
            self._active_job = target_jid or "batch_history"
            self._active_name = label
            self._progress_text = label
            self._last_error = None

        def _worker() -> None:
            err: Optional[str] = None
            try:
                if target_jid is not None:
                    self.engine.resynthesize_job(
                        target_jid,
                        checkpoint=checkpoint,
                        device=device,
                        denoise=denoise,
                        denoise_preset=denoise_preset,
                        url_prefix="/api/jobs",
                    )
                else:
                    def _prog(i: int, tot: int, name: str) -> None:
                        with self._lock:
                            self._progress_text = f"正在批量重合成 ({i}/{tot}): {name}"

                    self.engine.resynthesize_all(
                        checkpoint=checkpoint,
                        device=device,
                        on_progress=_prog,
                        url_prefix="/api/jobs",
                    )
            except Exception as exc:
                err = str(exc)
            finally:
                with self._lock:
                    self._running = False
                    self._progress_text = ""
                    self._last_error = err

        threading.Thread(target=_worker, daemon=True).start()
        return {"started": True, "job_id": target_jid or "batch_history", "checkpoint": checkpoint}


def _parse_multipart_payload(ctype: str, raw: bytes) -> Tuple[bytes, str, Optional[bytes], str, Dict[str, str]]:
    """Parse multipart/form-data fields cleanly using stdlib email.parser (Python 3.11+)."""
    hdr = f"Content-Type: {ctype}\r\nMIME-Version: 1.0\r\n\r\n".encode("latin-1", errors="replace")
    msg = BytesParser(policy=email_default_policy).parsebytes(hdr + raw)
    file_bytes = b""
    file_name = ""
    spk_bytes: Optional[bytes] = None
    spk_name = ""
    fields: Dict[str, str] = {}
    if msg.is_multipart():
        for part in msg.iter_parts():
            pname = part.get_param("name", header="content-disposition") or ""
            payload = part.get_payload(decode=True) or b""
            pfn = part.get_filename()
            if pname == "file":
                file_bytes = payload
                if pfn:
                    file_name = pfn
            elif pname == "speaker_ref":
                if payload:
                    spk_bytes = payload
                    if pfn:
                        spk_name = pfn
            elif pfn is None:
                fields[pname] = payload.decode("utf-8", errors="replace").strip()
    return file_bytes, file_name, spk_bytes, spk_name, fields


def make_handler(runner: TractStudioJobRunner, web_dir: Optional[Path] = None):
    static_root = (web_dir or find_web_dir()).resolve()
    work_root = runner.engine.config.work_dir.resolve()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            return

        def _write_cors(self) -> None:
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Disposition")

        def _send_bytes(self, data: bytes, ctype: str, status: int = 200) -> None:
            try:
                self.send_response(status)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                self._write_cors()
                self.end_headers()
                self.wfile.write(data)
            except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
                return

        def _send_json(self, obj: Any, status: int = 200) -> None:
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self._send_bytes(body, "application/json; charset=utf-8", status=status)

        def _send_ranged_bytes(
            self,
            data: bytes,
            *,
            ctype: str = "audio/wav",
            download_name: Optional[str] = None,
        ) -> None:
            total = len(data)
            disp = f'attachment; filename="{download_name}"' if download_name else None
            rng_hdr = self.headers.get("Range")
            try:
                if rng_hdr and rng_hdr.startswith("bytes="):
                    m = re.match(r"bytes=(\d*)-(\d*)", rng_hdr.strip())
                    if m and (m.group(1) or m.group(2)):
                        start = int(m.group(1)) if m.group(1) else max(0, total - int(m.group(2)))
                        end = int(m.group(2)) if (m.group(1) and m.group(2)) else total - 1
                        end = min(end, total - 1)
                        if start >= total or start > end:
                            self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                            self.send_header("Content-Range", f"bytes */{total}")
                            self._write_cors()
                            self.end_headers()
                            return
                        chunk = data[start : end + 1]
                        self.send_response(HTTPStatus.PARTIAL_CONTENT)
                        self.send_header("Content-Type", ctype)
                        self.send_header("Accept-Ranges", "bytes")
                        self.send_header("Cache-Control", "no-store")
                        self._write_cors()
                        if disp:
                            self.send_header("Content-Disposition", disp)
                        self.send_header("Content-Range", f"bytes {start}-{end}/{total}")
                        self.send_header("Content-Length", str(len(chunk)))
                        self.end_headers()
                        self.wfile.write(chunk)
                        return
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", ctype)
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Cache-Control", "no-store")
                self._write_cors()
                if disp:
                    self.send_header("Content-Disposition", disp)
                self.send_header("Content-Length", str(total))
                self.end_headers()
                self.wfile.write(data)
            except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
                return

        def do_OPTIONS(self) -> None:
            try:
                self.send_response(HTTPStatus.NO_CONTENT)
                self._write_cors()
                self.end_headers()
            except Exception:
                return

        def do_GET(self) -> None:
            parsed = urlparse(self.path)
            path = unquote(parsed.path)
            qs = parse_qs(parsed.query)

            if path == "/api/health":
                self._send_json(runner.engine.diagnostics())
                return

            if path == "/api/meta":
                cfg = runner.engine.config
                self._send_json(
                    {
                        "checkpoints": inspect_available_checkpoints(cfg.run_root),
                        "default_checkpoint": cfg.default_checkpoint,
                        "default_device": cfg.default_device,
                        "denoise_presets": [
                            {"id": p.preset, "label": p.label, "highpass_hz": p.highpass_hz}
                            for p in DENOISE_PRESETS.values()
                        ],
                        "themes": list(THEME_CATALOG),
                        "max_upload_mb": cfg.max_upload_bytes // (1024 * 1024),
                        "max_duration_sec": cfg.max_duration_sec,
                    }
                )
                return

            if path == "/api/state":
                self._send_json(runner.state())
                return

            if path.startswith("/api/denoise_preview/"):
                parts = [p for p in path[len("/api/denoise_preview/") :].split("/") if p]
                if len(parts) != 2:
                    self._send_json({"error": "invalid preview path"}, status=404)
                    return
                try:
                    data, dl_name = runner.get_preview_wav(parts[0], parts[1])
                except FileNotFoundError as exc:
                    self._send_json({"error": str(exc)}, status=404)
                    return
                dl = qs.get("download", ["0"])[0] == "1"
                self._send_ranged_bytes(data, ctype="audio/wav", download_name=dl_name if dl else None)
                return

            if path.startswith("/api/jobs/"):
                sub = [p for p in path[len("/api/jobs/") :].split("/") if p]
                if not sub or not SAFE_JOB_RE.match(sub[0]):
                    self._send_json({"error": "invalid job_id"}, status=404)
                    return
                job_id = sub[0]
                job_dir = (work_root / job_id).resolve()
                if job_dir.parent != work_root or not job_dir.is_dir():
                    self._send_json({"error": "job not found"}, status=404)
                    return

                if len(sub) == 1:
                    try:
                        self._send_json(runner.engine.get_job(job_id, url_prefix="/api/jobs"))
                    except FileNotFoundError as exc:
                        self._send_json({"error": str(exc)}, status=404)
                    return

                if len(sub) == 2 and sub[1] == "anim":
                    try:
                        fps = int(qs.get("fps", ["25"])[0])
                    except ValueError:
                        fps = 25
                    try:
                        raw_anim = runner.engine.get_job_animation_bytes(job_id, fps=fps)
                    except FileNotFoundError as exc:
                        self._send_json({"error": str(exc)}, status=404)
                        return
                    self._send_bytes(raw_anim, "application/json; charset=utf-8")
                    return

                if len(sub) == 2 and sub[1] == "controls":
                    fmt = qs.get("format", ["json"])[0].lower()
                    if fmt == "npz":
                        npz_file = (job_dir / "controls_m27.npz").resolve()
                        if not npz_file.is_file():
                            self._send_json({"error": "controls_m27.npz not found"}, status=404)
                            return
                        self._send_ranged_bytes(
                            npz_file.read_bytes(),
                            ctype="application/octet-stream",
                            download_name=f"{job_id}_controls_m27.npz",
                        )
                        return
                    try:
                        ctrl = runner.engine.get_job_controls(job_id)
                        payload = {
                            "job_id": ctrl["job_id"],
                            "fps": ctrl["fps"],
                            "frames": ctrl["frames"],
                            "names": ctrl["names"],
                            "m27_50hz": np.round(ctrl["m27_50hz"], 5).tolist(),
                        }
                        self._send_json(payload)
                    except FileNotFoundError as exc:
                        self._send_json({"error": str(exc)}, status=404)
                    return

                if len(sub) == 3 and sub[1] == "audio":
                    fname = sub[2]
                    if not SAFE_AUDIO_FILE_RE.match(fname):
                        self._send_json({"error": "invalid file"}, status=404)
                        return
                    target = (job_dir / fname).resolve()
                    if target.parent != job_dir or not target.is_file():
                        self._send_json({"error": "file not found"}, status=404)
                        return
                    dl = qs.get("download", ["0"])[0] == "1"
                    ctype = "audio/wav" if fname.endswith(".wav") else "application/octet-stream"
                    self._send_ranged_bytes(
                        target.read_bytes(),
                        ctype=ctype,
                        download_name=f"{job_id}_{fname}" if dl else None,
                    )
                    return

                self._send_json({"error": "unknown job endpoint"}, status=404)
                return

            # Compatibility route matching monitor dashboard (/web_infer/{job_id}/{file})
            if path.startswith("/web_infer/"):
                rel = [p for p in path[len("/web_infer/") :].split("/") if p]
                if len(rel) == 2 and SAFE_JOB_RE.match(rel[0]) and SAFE_AUDIO_FILE_RE.match(rel[1]):
                    job_dir = (work_root / rel[0]).resolve()
                    target = (job_dir / rel[1]).resolve()
                    if job_dir.parent == work_root and target.parent == job_dir and target.is_file():
                        dl = qs.get("download", ["0"])[0] == "1"
                        self._send_ranged_bytes(
                            target.read_bytes(),
                            ctype="audio/wav",
                            download_name=f"{rel[0]}_{rel[1]}" if dl else None,
                        )
                        return
                self._send_json({"error": "file not found"}, status=404)
                return

            # Static web files
            rel_static = "index.html" if path in ("/", "") else path.lstrip("/")
            target_static = (static_root / rel_static).resolve()
            if not str(target_static).startswith(str(static_root)) or not target_static.is_file():
                self._send_bytes(b"Not Found", "text/plain; charset=utf-8", status=HTTPStatus.NOT_FOUND)
                return
            ctype, _ = mimetypes.guess_type(str(target_static))
            ctype = ctype or "application/octet-stream"
            if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
                ctype += "; charset=utf-8"
            self._send_bytes(target_static.read_bytes(), ctype)

        def do_POST(self) -> None:
            parsed = urlparse(self.path)
            path = unquote(parsed.path)
            qs = parse_qs(parsed.query)

            max_bytes = 2 * runner.engine.config.max_upload_bytes
            try:
                clen = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                clen = 0
            if clen < 0 or clen > max_bytes:
                self._send_json({"error": "请求体大小无效或超过上限"}, status=400)
                return
            raw_body = self.rfile.read(clen) if clen > 0 else b""
            ctype = self.headers.get("Content-Type", "")

            if path == "/api/denoise":
                fname = unquote(qs.get("filename", ["upload.wav"])[0])
                preset = qs.get("preset", ["standard"])[0]
                file_bytes = raw_body
                if "multipart/form-data" in ctype.lower():
                    fb, fn, _, _, fields = _parse_multipart_payload(ctype, raw_body)
                    file_bytes = fb
                    if fn:
                        fname = fn
                    if fields.get("preset"):
                        preset = fields["preset"]
                try:
                    res = runner.create_denoise_preview(file_bytes, filename=fname, preset=preset)
                    self._send_json(res, status=200)
                except Exception as exc:
                    self._send_json({"error": str(exc)}, status=400)
                return

            if path == "/api/reconstruct":
                fname = unquote(qs.get("filename", ["upload.wav"])[0])
                spk_fname = unquote(qs.get("spk_filename", [""])[0])
                ckpt = qs.get("checkpoint", [runner.engine.config.default_checkpoint])[0]
                dev = qs.get("device", [runner.engine.config.default_device])[0]
                denoise_flag = qs.get("denoise", ["0"])[0].lower() in ("1", "true", "yes", "on")
                denoise_preset = qs.get("denoise_preset", ["standard"])[0]
                preview_id = qs.get("preview_id", [""])[0].strip() or None

                file_bytes: Optional[bytes] = raw_body if raw_body else None
                spk_bytes: Optional[bytes] = None
                if "multipart/form-data" in ctype.lower():
                    fb, fn, sb, sfn, fields = _parse_multipart_payload(ctype, raw_body)
                    file_bytes = fb or None
                    if fn:
                        fname = fn
                    if sb:
                        spk_bytes = sb
                    if sfn:
                        spk_fname = sfn
                    if fields.get("checkpoint"):
                        ckpt = fields["checkpoint"]
                    if fields.get("device"):
                        dev = fields["device"]
                    if "denoise" in fields:
                        denoise_flag = fields["denoise"].lower() in ("1", "true", "yes", "on")
                    if fields.get("denoise_preset"):
                        denoise_preset = fields["denoise_preset"]
                    if fields.get("preview_id"):
                        preview_id = fields["preview_id"]

                try:
                    res = runner.submit_reconstruct(
                        file_bytes,
                        filename=fname,
                        preview_id=preview_id,
                        checkpoint=ckpt,
                        device=dev,
                        denoise=denoise_flag,
                        denoise_preset=denoise_preset,
                        spk_bytes=spk_bytes,
                        spk_filename=spk_fname,
                    )
                    self._send_json(res, status=202)
                except Exception as exc:
                    status = 409 if "仍在处理" in str(exc) else 400
                    self._send_json({"error": str(exc)}, status=status)
                return

            if path == "/api/resynth":
                ckpt = qs.get("checkpoint", [runner.engine.config.default_checkpoint])[0]
                dev = qs.get("device", [runner.engine.config.default_device])[0]
                jid = qs.get("job_id", [""])[0].strip() or None
                dn_param = qs.get("denoise", [""])[0].strip().lower()
                denoise_opt: Optional[bool] = None
                if dn_param in ("1", "true", "yes", "on"):
                    denoise_opt = True
                elif dn_param in ("0", "false", "no", "off"):
                    denoise_opt = False
                denoise_preset = qs.get("denoise_preset", [""])[0].strip() or None

                if "application/json" in ctype.lower() and raw_body:
                    try:
                        jb = json.loads(raw_body.decode("utf-8"))
                        ckpt = jb.get("checkpoint", ckpt)
                        dev = jb.get("device", dev)
                        jid = jb.get("job_id", jid)
                        if "denoise" in jb and jb["denoise"] is not None:
                            denoise_opt = bool(jb["denoise"])
                        if jb.get("denoise_preset"):
                            denoise_preset = str(jb["denoise_preset"])
                    except Exception:
                        pass

                try:
                    res = runner.submit_resynth(
                        checkpoint=ckpt,
                        device=dev,
                        job_id=jid,
                        denoise=denoise_opt,
                        denoise_preset=denoise_preset,
                    )
                    self._send_json(res, status=202)
                except FileNotFoundError as exc:
                    self._send_json({"error": str(exc)}, status=404)
                except Exception as exc:
                    status = 409 if "仍在处理" in str(exc) else 400
                    self._send_json({"error": str(exc)}, status=status)
                return

            self._send_json({"error": f"unknown endpoint: {path}"}, status=404)

    return Handler


class _ExclusiveThreadingHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = False


def main() -> None:
    parser = argparse.ArgumentParser(description="M27 Tract Studio standalone server (CPU-safe, themeable web UI)")
    parser.add_argument("--host", type=str, default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18799)
    parser.add_argument("--train-root", type=Path, default=DEFAULT_TRAIN_ROOT)
    parser.add_argument("--run-root", type=Path, default=None)
    parser.add_argument("--work-dir", type=Path, default=None)
    parser.add_argument("--device", choices=("cpu", "auto", "cuda"), default="cpu")
    args = parser.parse_args()

    cfg = TractStudioConfig(
        train_root=args.train_root,
        run_root=args.run_root,
        work_dir=args.work_dir,
        default_device=args.device,
    )
    engine = TractReconstructionEngine(cfg)
    runner = TractStudioJobRunner(engine)
    web_dir = find_web_dir()
    srv = _ExclusiveThreadingHTTPServer((args.host, args.port), make_handler(runner, web_dir))
    print(
        f"[M27TractStudio] Listening on http://{args.host}:{args.port}/ "
        f"(device={cfg.default_device}, work_dir={cfg.work_dir})",
        flush=True,
    )
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
        engine.close()


if __name__ == "__main__":
    main()
