"""Standalone HTTP API + themeable web studio server for M27 Voice Morph (CPU-safe, zero-VRAM)."""
from __future__ import annotations

import argparse
import base64
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import mimetypes
from pathlib import Path
from typing import Any, Dict, Tuple
from urllib.parse import unquote, urlparse
import uuid

import soundfile as sf

from .alignment import parse_textgrid_boundaries
from .morpher import DualMorphConfig, PresetMorphConfig
from .presets import ORGAN_GROUPS, extract_phonation_preset_from_m27_phys
from .runtime import AnalyzedClip, SAMPLE_RATE_16K, VoiceMorphEngine

PKG_ROOT = Path(__file__).resolve().parent.parent.parent
WEB_DIR = PKG_ROOT / "web"


class MorphStudioState:
    def __init__(self, engine: VoiceMorphEngine) -> None:
        self.engine = engine
        self.clips: Dict[str, AnalyzedClip] = {}
        self.renders: Dict[str, Tuple[bytes, str]] = {}

    def put_clip(self, clip: AnalyzedClip) -> None:
        # Keep memory bounded (latest 24 clips)
        if len(self.clips) >= 24:
            oldest = next(iter(self.clips.keys()))
            del self.clips[oldest]
        self.clips[clip.clip_id] = clip

    def put_render(self, wav_bytes: bytes, name: str) -> str:
        if len(self.renders) >= 32:
            oldest = next(iter(self.renders.keys()))
            del self.renders[oldest]
        rid = uuid.uuid4().hex[:10]
        self.renders[rid] = (wav_bytes, name)
        return rid


def _wav_to_bytes(wav, sr: int) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, wav, int(sr), format="WAV", subtype="PCM_16")
    return buf.getvalue()


def make_handler(state: MorphStudioState, web_dir: Path = WEB_DIR):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: Any) -> None:
            return

        def _send_bytes(self, data: bytes, ctype: str, status: int = 200) -> None:
            try:
                self.send_response(status)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(data)
            except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
                return

        def _send_json(self, obj: Any, status: int = 200) -> None:
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self._send_bytes(body, "application/json; charset=utf-8", status=status)

        def _read_json_body(self) -> Dict[str, Any]:
            n = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(n) if n > 0 else b"{}"
            return json.loads(raw.decode("utf-8"))

        def do_OPTIONS(self) -> None:
            try:
                self.send_response(204)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type")
                self.end_headers()
            except Exception:
                return

        def do_GET(self) -> None:
            path = unquote(urlparse(self.path).path)
            if path == "/api/meta":
                self._send_json(
                    {
                        "presets": state.engine.preset_store.load_all(),
                        "organ_groups": ORGAN_GROUPS,
                        "synthesizers": state.engine.available_synthesizers(),
                        "demos": state.engine.list_demo_samples(),
                    }
                )
                return
            if path.startswith("/api/clip_audio/"):
                cid = path[len("/api/clip_audio/") :].strip("/")
                clip = state.clips.get(cid)
                if clip is None:
                    self._send_json({"error": "clip not found"}, status=404)
                    return
                self._send_bytes(_wav_to_bytes(clip.wav_16k, SAMPLE_RATE_16K), "audio/wav")
                return
            if path.startswith("/api/render_audio/"):
                rid = path[len("/api/render_audio/") :].strip("/")
                item = state.renders.get(rid)
                if item is None:
                    self._send_json({"error": "render not found"}, status=404)
                    return
                self._send_bytes(item[0], "audio/wav")
                return

            rel = "index.html" if path in ("/", "") else path.lstrip("/")
            target = (web_dir / rel).resolve()
            if not str(target).startswith(str(web_dir.resolve())) or not target.is_file():
                self._send_bytes(b"Not Found", "text/plain; charset=utf-8", status=HTTPStatus.NOT_FOUND)
                return
            ctype, _ = mimetypes.guess_type(str(target))
            ctype = ctype or "application/octet-stream"
            if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
                ctype += "; charset=utf-8"
            self._send_bytes(target.read_bytes(), ctype)

        def do_POST(self) -> None:
            path = unquote(urlparse(self.path).path)
            try:
                body = self._read_json_body()
                if path == "/api/analyze":
                    demo_id = body.get("demo_id")
                    if demo_id:
                        demos = {d["id"]: d for d in state.engine.list_demo_samples()}
                        if demo_id not in demos:
                            self._send_json({"error": f"demo not found: {demo_id}"}, status=404)
                            return
                        src = Path(demos[demo_id]["path"])
                        name = demos[demo_id]["label"]
                        cid = f"demo_{demo_id}_{uuid.uuid4().hex[:6]}"
                        clip = state.engine.analyze_audio(src, clip_id=cid, name=name)
                    else:
                        b64 = str(body.get("audio_base64", ""))
                        if "," in b64:
                            b64 = b64.split(",", 1)[1]
                        raw_bytes = base64.b64decode(b64)
                        name = str(body.get("name", "uploaded.wav"))
                        cid = f"clip_{uuid.uuid4().hex[:8]}"
                        clip = state.engine.analyze_audio(raw_bytes, clip_id=cid, name=name)

                    state.put_clip(clip)
                    self._send_json(
                        {
                            "ok": True,
                            "clip": clip.to_public_meta(),
                            "audio_url": f"/api/clip_audio/{clip.clip_id}",
                        }
                    )
                    return

                if path == "/api/extract_preset":
                    cid = str(body.get("clip_id", ""))
                    clip = state.clips.get(cid)
                    if clip is None:
                        self._send_json({"error": "请先加载音频"}, status=400)
                        return
                    extracted = extract_phonation_preset_from_m27_phys(
                        clip.m27_phys,
                        voiced_mask=clip.voiced_gate > 0.5,
                        t_start_sec=body.get("t_start_sec"),
                        t_end_sec=body.get("t_end_sec"),
                    )
                    pid = str(body.get("preset_id") or f"custom_{uuid.uuid4().hex[:6]}")
                    label = str(body.get("label") or f"自定义 · {clip.name[:12]}")
                    saved = state.engine.preset_store.save_custom(
                        pid,
                        label=label,
                        source9_phys=extracted["source9_phys"],
                        f0_shift_semitones=float(body.get("f0_shift_semitones", 0.0)),
                        ref_f0_hz=extracted["ref_f0_hz"],
                        is_voiceless_target=extracted["is_voiceless_target"],
                    )
                    self._send_json({"ok": True, "preset": saved, "presets": state.engine.preset_store.load_all()})
                    return

                if path == "/api/render_preset":
                    cid = str(body.get("clip_id", ""))
                    clip = state.clips.get(cid)
                    if clip is None:
                        self._send_json({"error": "请先加载音频"}, status=400)
                        return
                    cfg = PresetMorphConfig(
                        preset_id=str(body.get("preset_id", "breathy")),
                        knots=body.get("knots") or [{"t": 0.0, "v": 0.0}, {"t": 1.0, "v": 0.85}],
                        interp_mode=str(body.get("interp_mode", "smoothstep")),
                        enable_voicing_gate=bool(body.get("enable_voicing_gate", True)),
                        smooth_ms=float(body.get("smooth_ms", 25.0)),
                        enable_f0_coupling=bool(body.get("enable_f0_coupling", False)),
                        f0_shift_semitones=(
                            float(body["f0_shift_semitones"])
                            if body.get("f0_shift_semitones") not in (None, "")
                            else None
                        ),
                        f0_coupling_strength=float(body.get("f0_coupling_strength", 1.0)),
                        pr_modulation_ratio=float(body.get("pr_modulation_ratio", 0.60)),
                    )
                    out = state.engine.render_preset_morph(clip, cfg, synth_id=str(body.get("synth_id", "auto")))
                    rid = state.put_render(_wav_to_bytes(out["wav"], out["sr"]), f"{clip.name}__{cfg.preset_id}.wav")
                    self._send_json(
                        {
                            "ok": True,
                            "audio_url": f"/api/render_audio/{rid}",
                            "synth_label": out["synth_label"],
                            "synth_ms": out["synth_ms"],
                            "sr": out["sr"],
                            "applied_semitones": out["applied_semitones"],
                            "w_eff": [round(float(x), 3) for x in out["w_eff"].tolist()],
                            "w_smooth": [round(float(x), 3) for x in out["w_smooth"].tolist()],
                            "f0_after_hz": [round(float(x), 1) for x in out["f0_after_hz"].tolist()],
                        }
                    )
                    return

                if path == "/api/render_dual":
                    cid_a = str(body.get("clip_a_id", ""))
                    cid_b = str(body.get("clip_b_id", ""))
                    clip_a = state.clips.get(cid_a)
                    clip_b = state.clips.get(cid_b)
                    if clip_a is None or clip_b is None:
                        self._send_json({"error": "请先加载说话人 A 与说话人 B 两段音频"}, status=400)
                        return

                    anchors = body.get("anchors_sec") or []
                    tg_a = str(body.get("textgrid_a", "")).strip()
                    tg_b = str(body.get("textgrid_b", "")).strip()
                    if tg_a and tg_b and not anchors:
                        ba = parse_textgrid_boundaries(tg_a)
                        bb = parse_textgrid_boundaries(tg_b)
                        anchors = [{"t_a": a_t, "t_b": b_t} for (a_t, _), (b_t, _) in zip(ba, bb)]

                    cfg = DualMorphConfig(
                        align_mode=str(body.get("align_mode", "dtw")),
                        anchors_sec=anchors,
                        group_curves=body.get("group_curves") or {},
                        delta_groups=body.get("delta_groups") or [],
                        interp_mode=str(body.get("interp_mode", "smoothstep")),
                        enable_voicing_gate=bool(body.get("enable_voicing_gate", True)),
                        smooth_ms=float(body.get("smooth_ms", 25.0)),
                        enable_f0_coupling=bool(body.get("enable_f0_coupling", False)),
                        f0_coupling_strength=float(body.get("f0_coupling_strength", 1.0)),
                    )
                    out = state.engine.render_dual_morph(clip_a, clip_b, cfg, synth_id=str(body.get("synth_id", "auto")))
                    rid = state.put_render(_wav_to_bytes(out["wav"], out["sr"]), "dual_morph.wav")
                    self._send_json(
                        {
                            "ok": True,
                            "audio_url": f"/api/render_audio/{rid}",
                            "synth_label": out["synth_label"],
                            "synth_ms": out["synth_ms"],
                            "sr": out["sr"],
                            "align_info": out["align_info"],
                            "auto_f0_shift_semitones": out["auto_f0_shift_semitones"],
                            "f0_after_hz": [round(float(x), 1) for x in out["f0_after_hz"].tolist()],
                        }
                    )
                    return

                self._send_json({"error": f"unknown endpoint: {path}"}, status=404)
            except Exception as exc:
                self._send_json({"error": str(exc)}, status=500)

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description="M27 Voice Morph standalone CPU-safe studio server")
    parser.add_argument("--host", type=str, default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18798)
    parser.add_argument("--train-root", type=Path, default=Path(r"F:\TensorTract3_Train"))
    args = parser.parse_args()

    engine = VoiceMorphEngine(train_root=args.train_root, device="cpu")
    state = MorphStudioState(engine)
    srv = ThreadingHTTPServer((args.host, args.port), make_handler(state, WEB_DIR))
    print(f"[M27VoiceMorph] Studio listening on http://{args.host}:{args.port}/ (CPU-safe, zero-VRAM)", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
