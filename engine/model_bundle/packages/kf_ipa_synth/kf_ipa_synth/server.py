"""Zero-dependency standalone HTTP server for kf_ipa_synth Web Studio & JSON API.

Run with:
    python -m kf_ipa_synth.server --host 127.0.0.1 --port 18798
"""
from __future__ import annotations

import argparse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
from pathlib import Path
from typing import Any, Optional
from urllib.parse import unquote, urlparse

from .api import IPASynthAPI
from .engine import EngineConfig, IPASynthEngine

WEB_ROOT = Path(__file__).resolve().parent.parent / "web"


def create_server(
    *,
    host: str = "127.0.0.1",
    port: int = 18798,
    config: Optional[EngineConfig] = None,
    jobs_dir: Optional[Path] = None,
    web_dir: Optional[Path] = None,
) -> ThreadingHTTPServer:
    engine = IPASynthEngine(config=config)
    api = IPASynthAPI(engine=engine, jobs_dir=jobs_dir)
    static_root = Path(web_dir) if web_dir else WEB_ROOT

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt: str, *args: Any) -> None:
            return

        def _send_cors(self) -> None:
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")

        def _send_json(self, obj: Any, status: int = 200) -> None:
            raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self._send_cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(raw)

        def _send_file(self, path: Path, content_type: Optional[str] = None) -> None:
            if not path.is_file():
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            data = path.read_bytes()
            ctype = content_type or mimetypes.guess_type(str(path))[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
                ctype += "; charset=utf-8"
            self.send_response(HTTPStatus.OK)
            self._send_cors()
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def _read_json(self) -> dict:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(min(length, 25 * 1024 * 1024))
            return json.loads(raw.decode("utf-8")) if raw else {}

        def do_OPTIONS(self) -> None:
            self.send_response(HTTPStatus.NO_CONTENT)
            self._send_cors()
            self.end_headers()

        def do_GET(self) -> None:
            p = urlparse(self.path).path
            if p == "/api/models":
                self._send_json(api.get_models())
                return
            if p == "/api/history":
                self._send_json(api.get_history())
                return
            if p == "/api/speakers":
                self._send_json(api.get_speakers())
                return
            if p.startswith("/api/job/"):
                parts = [unquote(x) for x in p.removeprefix("/api/job/").split("/") if x]
                if len(parts) == 2:
                    target = api.resolve_job_file(parts[0], parts[1])
                    if target is not None:
                        ctype = "audio/wav" if parts[1].endswith(".wav") else "application/json"
                        self._send_file(target, ctype)
                        return
                self.send_error(HTTPStatus.NOT_FOUND)
                return

            # Static frontend files
            rel = "index.html" if p in ("/", "/index.html") else p.lstrip("/")
            if ".." in rel:
                self.send_error(HTTPStatus.BAD_REQUEST)
                return
            target = (static_root / rel).resolve()
            try:
                target.relative_to(static_root.resolve())
            except ValueError:
                self.send_error(HTTPStatus.FORBIDDEN)
                return
            self._send_file(target)

        def do_POST(self) -> None:
            p = urlparse(self.path).path
            try:
                body = self._read_json()
            except Exception as exc:
                self._send_json({"ok": False, "error": f"无效 JSON: {exc}"}, status=400)
                return

            try:
                if p == "/api/text2ipa":
                    code, data = api.post_text2ipa(body)
                elif p == "/api/validate_ipa":
                    code, data = api.post_validate_ipa(body)
                elif p == "/api/pose/resolve":
                    code, data = api.post_resolve_pose(body)
                elif p == "/api/tract/contour":
                    code, data = api.post_tract_contour(body)
                elif p in ("/api/synthesize", "/api/infer"):
                    code, data = api.post_synthesize(body)
                elif p == "/api/speakers/enroll":
                    code, data = api.post_enroll_speaker(body)
                else:
                    self.send_error(HTTPStatus.NOT_FOUND)
                    return
                self._send_json(data, status=code)
            except Exception as exc:
                self._send_json({"ok": False, "error": str(exc)}, status=500)

        def do_DELETE(self) -> None:
            p = urlparse(self.path).path
            if p.startswith("/api/speakers/"):
                pid = unquote(p.removeprefix("/api/speakers/")).strip("/")
                code, data = api.delete_speaker(pid)
                self._send_json(data, status=code)
                return
            self.send_error(HTTPStatus.NOT_FOUND)

    return ThreadingHTTPServer((host, int(port)), Handler)


def main() -> None:
    parser = argparse.ArgumentParser(description="Standalone KF-IPA-Synth Web Studio & API Server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18798)
    parser.add_argument("--device", default="cpu", choices=("cpu", "cuda"))
    parser.add_argument("--assets-dir", type=Path, default=None)
    parser.add_argument("--vocoder-ckpt", type=Path, default=None)
    parser.add_argument("--no-native-vtl", action="store_true")
    args = parser.parse_args()

    cfg = EngineConfig(
        assets_dir=args.assets_dir,
        vocoder_checkpoint=args.vocoder_ckpt,
        device=args.device,
        enable_native_vtl=not args.no_native_vtl,
    )
    server = create_server(host=args.host, port=args.port, config=cfg)
    print(f"[kf_ipa_synth] Studio & API ready at http://{args.host}:{args.port} (device={args.device})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
