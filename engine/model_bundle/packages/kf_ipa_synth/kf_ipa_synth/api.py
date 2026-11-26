"""Framework-agnostic HTTP/JSON API adapter + optional FastAPI router for kf_ipa_synth."""
from __future__ import annotations

import base64
from datetime import datetime
import json
from pathlib import Path
import shutil
import tempfile
from typing import Any, Dict, List, Optional, Tuple
import uuid

from .engine import EngineConfig, IPASynthEngine


class IPASynthAPI:
    """Stateless-friendly JSON request handler + bounded job artifact store."""

    def __init__(
        self,
        engine: Optional[IPASynthEngine] = None,
        jobs_dir: Optional[Path] = None,
        max_jobs: int = 30,
    ) -> None:
        self.engine = engine or IPASynthEngine()
        self.jobs_dir = Path(jobs_dir) if jobs_dir else (Path(tempfile.gettempdir()) / "kf_ipa_synth_jobs")
        self.jobs_dir.mkdir(parents=True, exist_ok=True)
        self.max_jobs = max(5, int(max_jobs))

    def _prune_old_jobs(self) -> None:
        dirs = sorted([d for d in self.jobs_dir.iterdir() if d.is_dir()], reverse=True)
        for old in dirs[self.max_jobs :]:
            shutil.rmtree(old, ignore_errors=True)

    def get_models(self) -> Dict[str, Any]:
        info = self.engine.list_models()
        info["ok"] = True
        info["speakers"] = self.engine.speaker_store.list_profiles()
        return info

    def post_text2ipa(self, body: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]:
        res = self.engine.text_to_timeline(
            str(body.get("text", "")),
            lang=str(body.get("lang", "auto")),
            bpm=float(body.get("bpm", 96.0)),
            base_f0=float(body.get("base_f0", 155.0)),
            tone_sandhi=bool(body.get("tone_sandhi", True)),
        )
        return (200 if res.get("ok") else 400), res

    def post_validate_ipa(self, body: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]:
        return 200, self.engine.validate_ipa(str(body.get("ipa", "")))

    def post_resolve_pose(self, body: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]:
        kf = body.get("keyframe") if isinstance(body.get("keyframe"), dict) else body
        res = self.engine.resolve_keyframe_pose(
            kf,
            include_contour=bool(body.get("include_contour", True)),
            dirty_b_donor=str(body.get("dirty_b_donor", "")),
        )
        return 200, res

    def post_tract_contour(self, body: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]:
        params = body.get("params") if isinstance(body.get("params"), dict) else body
        return 200, self.engine.preview_tract_contour(params)

    def post_synthesize(self, body: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]:
        job_id = datetime.now().strftime("%Y%m%d_%H%M%S_") + uuid.uuid4().hex[:6]
        job_dir = self.jobs_dir / job_id
        job_dir.mkdir(parents=True, exist_ok=True)
        (job_dir / "spec.json").write_text(json.dumps(body, indent=2, ensure_ascii=False), encoding="utf-8")
        out = self.engine.synthesize(body, out_dir=job_dir)
        summary = dict(out["summary"])
        summary["job_id"] = job_id
        summary["source_text"] = str(body.get("source_text", ""))
        (job_dir / "result.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
        self._prune_old_jobs()
        return 200, summary

    def get_history(self, limit: int = 15) -> List[Dict[str, Any]]:
        items: List[Dict[str, Any]] = []
        for d in sorted(self.jobs_dir.iterdir(), reverse=True):
            if not d.is_dir():
                continue
            rp = d / "result.json"
            if rp.is_file():
                try:
                    data = json.loads(rp.read_text(encoding="utf-8"))
                    data["job_id"] = d.name
                    items.append(data)
                except Exception:
                    pass
            if len(items) >= limit:
                break
        return items

    def resolve_job_file(self, job_id: str, filename: str) -> Optional[Path]:
        if ".." in job_id or ".." in filename or "/" in job_id or "\\" in job_id:
            return None
        target = (self.jobs_dir / job_id / filename).resolve()
        try:
            target.relative_to(self.jobs_dir.resolve())
        except ValueError:
            return None
        return target if target.is_file() else None

    def get_speakers(self) -> Dict[str, Any]:
        return {
            "ok": True,
            "encoder_ready": self.engine.speaker_store.encoder_available,
            "speakers": self.engine.speaker_store.list_profiles(),
        }

    def post_enroll_speaker(self, body: Dict[str, Any]) -> Tuple[int, Dict[str, Any]]:
        name = str(body.get("name", "")).strip() or "Speaker"
        profile_id = body.get("id")
        note = str(body.get("note", ""))
        if body.get("audio_b64"):
            raw_bytes = base64.b64decode(str(body["audio_b64"]))
            prof = self.engine.speaker_store.enroll_from_audio(name, raw_bytes, profile_id=profile_id, note=note)
            return 200, {"ok": True, "profile": prof}
        if body.get("wav_path"):
            p = Path(str(body["wav_path"]))
            if not p.is_file():
                return 400, {"ok": False, "error": f"音频文件不存在: {p}"}
            prof = self.engine.speaker_store.enroll_from_audio(name, p, profile_id=profile_id, note=note)
            return 200, {"ok": True, "profile": prof}
        return 400, {"ok": False, "error": "请提供 audio_b64 (base64 编码音频) 或 wav_path"}

    def delete_speaker(self, profile_id: str) -> Tuple[int, Dict[str, Any]]:
        ok = self.engine.speaker_store.delete_profile(profile_id)
        return (200 if ok else 404), {"ok": ok, "id": profile_id}


def create_fastapi_router(
    engine: Optional[IPASynthEngine] = None,
    *,
    jobs_dir: Optional[Path] = None,
    config: Optional[EngineConfig] = None,
) -> Any:
    """Create a drop-in FastAPI APIRouter mounting all kf_ipa_synth endpoints.

    Usage in a hackathon FastAPI app::

        from fastapi import FastAPI
        from kf_ipa_synth.api import create_fastapi_router

        app = FastAPI()
        app.include_router(create_fastapi_router(), prefix="/ipa")
    """
    from fastapi import APIRouter, Body, HTTPException
    from fastapi.responses import FileResponse

    eng = engine or IPASynthEngine(config=config)
    api = IPASynthAPI(engine=eng, jobs_dir=jobs_dir)
    router = APIRouter(tags=["kf-ipa-synth"])

    @router.get("/api/models")
    def _models():
        return api.get_models()

    @router.get("/api/history")
    def _history():
        return api.get_history()

    @router.post("/api/text2ipa")
    def _text2ipa(payload: Dict[str, Any] = Body(...)):
        code, data = api.post_text2ipa(payload)
        if code >= 400:
            raise HTTPException(status_code=code, detail=data.get("error", "text2ipa error"))
        return data

    @router.post("/api/validate_ipa")
    def _validate(payload: Dict[str, Any] = Body(...)):
        _, data = api.post_validate_ipa(payload)
        return data

    @router.post("/api/pose/resolve")
    def _resolve_pose(payload: Dict[str, Any] = Body(...)):
        _, data = api.post_resolve_pose(payload)
        return data

    @router.post("/api/tract/contour")
    def _contour(payload: Dict[str, Any] = Body(...)):
        _, data = api.post_tract_contour(payload)
        return data

    @router.post("/api/synthesize")
    def _synth(payload: Dict[str, Any] = Body(...)):
        _, data = api.post_synthesize(payload)
        return data

    @router.get("/api/job/{job_id}/{filename}")
    def _job_file(job_id: str, filename: str):
        target = api.resolve_job_file(job_id, filename)
        if target is None:
            raise HTTPException(status_code=404, detail="Job artifact not found")
        media = "audio/wav" if filename.endswith(".wav") else "application/json"
        return FileResponse(path=str(target), media_type=media)

    @router.get("/api/speakers")
    def _speakers():
        return api.get_speakers()

    @router.post("/api/speakers/enroll")
    def _enroll(payload: Dict[str, Any] = Body(...)):
        code, data = api.post_enroll_speaker(payload)
        if code >= 400:
            raise HTTPException(status_code=code, detail=data.get("error", "enroll error"))
        return data

    @router.delete("/api/speakers/{profile_id}")
    def _del_speaker(profile_id: str):
        code, data = api.delete_speaker(profile_id)
        if code >= 400:
            raise HTTPException(status_code=code, detail="Speaker not found")
        return data

    return router


__all__ = ["IPASynthAPI", "create_fastapi_router"]
