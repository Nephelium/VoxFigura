"""1 KB Speaker Profile Store backed by zero-WavLM SpkLite (BrowserLightSpeakerEncoder).

Each saved speaker profile stores a 512-d L2-normalized embedding in compact FP16 base64
(1,024 raw bytes -> ~1.5 KB JSON file on disk) and can be loaded directly by Stage5Lite or Teacher Stage 5.
"""
from __future__ import annotations

import base64
from datetime import datetime
import io
import json
from math import gcd
from pathlib import Path
import re
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from scipy.signal import resample_poly
import soundfile as sf
import torch

from .m27_contract import SAMPLE_RATE_16K
from .models import BrowserLightSpeakerEncoder, load_speaker_encoder

_SAFE_ID_RE = re.compile(r"[^a-zA-Z0-9_\-\u4e00-\u9fff]+")


def _encode_emb_fp16_b64(emb: np.ndarray) -> str:
    arr = np.asarray(emb, dtype=np.float32).reshape(-1)
    norm = float(np.linalg.norm(arr))
    if norm > 1e-8:
        arr = arr / norm
    raw = arr.astype(np.float16).tobytes()
    return base64.b64encode(raw).decode("ascii")


def _decode_emb_fp16_b64(b64_str: str) -> np.ndarray:
    raw = base64.b64decode(b64_str.encode("ascii"))
    arr = np.frombuffer(raw, dtype=np.float16).astype(np.float32)
    norm = float(np.linalg.norm(arr))
    return (arr / norm) if norm > 1e-8 else arr


def _read_mono_16k(audio_input: Path | bytes | np.ndarray, sample_rate: Optional[int] = None, max_sec: float = 12.0) -> Tuple[np.ndarray, float]:
    if isinstance(audio_input, np.ndarray):
        wav = np.asarray(audio_input, dtype=np.float32)
        sr = int(sample_rate or SAMPLE_RATE_16K)
    elif isinstance(audio_input, (bytes, bytearray)):
        wav, sr = sf.read(io.BytesIO(audio_input), dtype="float32", always_2d=False)
    else:
        wav, sr = sf.read(str(audio_input), dtype="float32", always_2d=False)
    if wav.ndim == 2:
        wav = wav.mean(axis=1)
    wav = np.asarray(wav, dtype=np.float32).reshape(-1)
    if sr != SAMPLE_RATE_16K:
        g = gcd(int(sr), SAMPLE_RATE_16K)
        wav = resample_poly(wav, SAMPLE_RATE_16K // g, int(sr) // g).astype(np.float32)
    dur_sec = float(wav.size) / float(SAMPLE_RATE_16K)
    max_samples = int(round(max_sec * SAMPLE_RATE_16K))
    if wav.size > max_samples:
        wav = wav[:max_samples]
    return wav, dur_sec


class SpeakerProfileStore:
    """Manages 1 KB `.spk.json` speaker profiles and on-the-fly SpkLite extraction."""

    def __init__(
        self,
        store_dir: Path,
        encoder_weights: Optional[Path] = None,
        device: str = "cpu",
    ) -> None:
        self.store_dir = Path(store_dir)
        self.store_dir.mkdir(parents=True, exist_ok=True)
        self.encoder_weights = Path(encoder_weights) if encoder_weights else None
        self.device = str(device)
        self._encoder: Optional[BrowserLightSpeakerEncoder] = None
        self._encoder_meta: Dict[str, Any] = {}

    @property
    def encoder_available(self) -> bool:
        return self.encoder_weights is not None and self.encoder_weights.is_file()

    def _get_encoder(self) -> BrowserLightSpeakerEncoder:
        if self._encoder is None:
            if not self.encoder_available or self.encoder_weights is None:
                raise FileNotFoundError(
                    "未找到 SpkLite 声纹编码器权重 (browser_spk_enc_fp16.pt / int8.pt)，"
                    "请检查 assets 目录或配置 encoder_weights。"
                )
            self._encoder, self._encoder_meta = load_speaker_encoder(self.encoder_weights, device=self.device)
        return self._encoder

    def extract_embedding(
        self,
        audio_input: Path | bytes | np.ndarray,
        *,
        sample_rate: Optional[int] = None,
    ) -> Tuple[np.ndarray, float]:
        """Extract an L2-normalized 512-d float32 speaker vector using SpkLite (~12 ms CPU)."""
        wav, dur_sec = _read_mono_16k(audio_input, sample_rate=sample_rate)
        if wav.size < 3200:
            raise ValueError("参考音频过短（至少需要 0.2 秒有效语音）")
        enc = self._get_encoder()
        with torch.no_grad():
            emb = enc(torch.from_numpy(wav[None, :]).to(self.device))[0].float().cpu().numpy()
        return emb.astype(np.float32), round(dur_sec, 2)

    def save_profile(
        self,
        name: str,
        embedding: np.ndarray,
        *,
        profile_id: Optional[str] = None,
        source_duration_sec: float = 0.0,
        note: str = "",
    ) -> Dict[str, Any]:
        clean_id = _SAFE_ID_RE.sub("_", (profile_id or name).strip()).strip("_") or f"spk_{datetime.now().strftime('%H%M%S')}"
        path = self.store_dir / f"{clean_id}.spk.json"
        payload = {
            "schema": "kf_spk_profile_v1",
            "id": clean_id,
            "name": name.strip() or clean_id,
            "dim": int(np.asarray(embedding).size),
            "space": "wavlm_sv_512",
            "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "source_duration_sec": round(float(source_duration_sec), 2),
            "note": note,
            "embedding_fp16_b64": _encode_emb_fp16_b64(embedding),
        }
        raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        path.write_text(raw, encoding="utf-8")
        return {
            "id": clean_id,
            "name": payload["name"],
            "dim": payload["dim"],
            "size_bytes": path.stat().st_size,
            "created_at": payload["created_at"],
            "source_duration_sec": payload["source_duration_sec"],
            "note": note,
            "path": str(path),
        }

    def enroll_from_audio(
        self,
        name: str,
        audio_input: Path | bytes | np.ndarray,
        *,
        sample_rate: Optional[int] = None,
        profile_id: Optional[str] = None,
        note: str = "",
    ) -> Dict[str, Any]:
        emb, dur_sec = self.extract_embedding(audio_input, sample_rate=sample_rate)
        return self.save_profile(name, emb, profile_id=profile_id, source_duration_sec=dur_sec, note=note)

    def load_embedding(self, profile_id_or_path: str) -> np.ndarray:
        p = Path(profile_id_or_path)
        if not p.is_file():
            p = self.store_dir / f"{profile_id_or_path}.spk.json"
        if not p.is_file():
            raise FileNotFoundError(f"未找到声纹档案: {profile_id_or_path}")
        raw = json.loads(p.read_text(encoding="utf-8"))
        if "embedding_fp16_b64" in raw:
            return _decode_emb_fp16_b64(str(raw["embedding_fp16_b64"]))
        if "embedding" in raw:
            arr = np.asarray(raw["embedding"], dtype=np.float32).reshape(-1)
            n = float(np.linalg.norm(arr))
            return (arr / n) if n > 1e-8 else arr
        raise ValueError(f"无效的声纹档案格式: {p}")

    def list_profiles(self) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        for p in sorted(self.store_dir.glob("*.spk.json")):
            try:
                raw = json.loads(p.read_text(encoding="utf-8"))
                out.append(
                    {
                        "id": raw.get("id", p.stem.replace(".spk", "")),
                        "name": raw.get("name", p.stem),
                        "dim": int(raw.get("dim", 512)),
                        "size_bytes": p.stat().st_size,
                        "created_at": raw.get("created_at", ""),
                        "source_duration_sec": raw.get("source_duration_sec", 0.0),
                        "note": raw.get("note", ""),
                    }
                )
            except Exception:
                continue
        return out

    def delete_profile(self, profile_id: str) -> bool:
        clean = _SAFE_ID_RE.sub("_", profile_id.strip()).strip("_")
        p = self.store_dir / f"{clean}.spk.json"
        if p.is_file():
            p.unlink()
            return True
        return False


__all__ = ["SpeakerProfileStore"]
