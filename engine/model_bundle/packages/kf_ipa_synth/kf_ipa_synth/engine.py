"""Resident thread-safe IPA-to-Vocal-Tract & Speech Synthesis Engine (`IPASynthEngine`).

Designed as a clean, copy-and-use Python SDK so other models, backend services, or hackathon apps can:
  1. Convert Mandarin / English / Japanese / inline [IPA] text into an editable multi-track timeline
  2. Validate IPA 2020 diacritics and illegal Place x Manner combinations
  3. Resolve any keyframe's 27-dim physical vocal-tract pose & accept micro-adjustments from a vocal-tract UI
  4. Run resident CPU/GPU KF2Tract27 trajectory prediction (zero subprocess overhead!)
  5. Synthesize speech via optional VTL R21 (48 kHz) AND/OR zero-WavLM Stage5Lite + SpkLite (16 kHz, 1 KB speaker profiles)
"""
from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import soundfile as sf
import torch

from .baseline import (
    build_condition_from_segments,
    kf26_and_f0_to_m27,
)
from .m27_contract import (
    M27_INDEX,
    M27_MAX,
    M27_MIN,
    M27_NAMES,
    SAMPLE_RATE_16K,
    SAMPLE_RATE_48K,
    denormalize_m27,
    normalize_f0_m27,
    normalize_m27,
)
from .models import (
    ConditionalHiFiGenerator27,
    KeyframeTractModel27,
    load_kf2tract_model,
    load_neural_vocoder,
)
from .phonetics import KF26_INDEX, SegmentEvent, validate_ipa_diacritics
from .pose_bank import PoseBank
from .schema import KeyframeSpec, M27_PARAM_SPECS, SynthRequest
from .speaker_store import SpeakerProfileStore
from .text2ipa import convert_text_to_timeline
from .tract_backend import TractBackend, qta_filter_m27_50_to_200


def _default_assets_dir() -> Path:
    env_dir = os.environ.get("KF_IPA_ASSETS_DIR", "").strip()
    if env_dir and Path(env_dir).is_dir():
        return Path(env_dir)
    return Path(__file__).resolve().parent.parent / "assets"


@dataclass
class EngineConfig:
    assets_dir: Optional[Path] = None
    kf_checkpoint: Optional[Path] = None
    vocoder_checkpoint: Optional[Path] = None
    speaker_encoder_checkpoint: Optional[Path] = None
    canonical_poses_path: Optional[Path] = None
    fallback_poses_path: Optional[Path] = None
    speaker_store_dir: Optional[Path] = None
    device: str = "cpu"
    enable_native_vtl: bool = True
    ptb_core_src: Optional[Path] = None
    vtl_native_dir: Optional[Path] = None


def _soft_limit(y: np.ndarray, knee: float = 0.85, ceiling: float = 0.97) -> np.ndarray:
    abs_y = np.abs(y)
    over = abs_y > knee
    if not np.any(over):
        return y
    out = y.copy()
    head = ceiling - knee
    out[over] = np.sign(y[over]) * (knee + head * np.tanh((abs_y[over] - knee) / head))
    return out


def _apply_output_gain(
    wav: np.ndarray,
    mode: str,
    sr: int = SAMPLE_RATE_48K,
    fixed_gain_db: float = 14.0,
) -> Tuple[np.ndarray, Dict[str, Any]]:
    w = np.asarray(wav, dtype=np.float32).reshape(-1).copy()
    n_in = min(int(0.003 * sr), w.size // 4)
    n_out = min(int(0.004 * sr), w.size // 4)
    if n_in > 1:
        w[:n_in] *= 0.5 * (1.0 - np.cos(np.pi * np.linspace(0.0, 1.0, n_in, dtype=np.float32)))
    if n_out > 1:
        w[-n_out:] *= 0.5 * (1.0 + np.cos(np.pi * np.linspace(0.0, 1.0, n_out, dtype=np.float32)))

    raw_peak = float(np.max(np.abs(w))) if w.size else 0.0
    hop = max(1, int(0.020 * sr))
    n_win = w.size // hop
    if n_win >= 1:
        frames = w[: n_win * hop].reshape(n_win, hop)
        frm_rms = np.sqrt(np.mean(frames * frames, axis=1) + 1e-12)
        max_frm = float(np.max(frm_rms))
        active = frm_rms[frm_rms >= max_frm * 0.0316]
        active_rms = float(np.sqrt(np.mean(active * active))) if active.size else max_frm
    else:
        active_rms = float(np.sqrt(np.mean(w * w) + 1e-12)) if w.size else 0.0

    if mode == "raw":
        gain_db = 0.0
        out = w
    elif mode == "auto_rms":
        target_rms = 10.0 ** (-18.0 / 20.0)
        gain_db = float(np.clip(20.0 * np.log10(target_rms / active_rms), 0.0, 26.0)) if active_rms > 1e-6 else 0.0
        out = _soft_limit(w * float(10.0 ** (gain_db / 20.0)), knee=0.85, ceiling=0.97).astype(np.float32)
    else:
        gain_db = float(fixed_gain_db)
        out = _soft_limit(w * float(10.0 ** (gain_db / 20.0)), knee=0.85, ceiling=0.97).astype(np.float32)

    out_peak = float(np.max(np.abs(out))) if out.size else 0.0
    out_rms = active_rms * float(10.0 ** (gain_db / 20.0))
    return out, {
        "gain_mode": mode,
        "gain_db": round(gain_db, 1),
        "raw_peak": round(raw_peak, 5),
        "out_peak": round(out_peak, 4),
        "out_peak_dbfs": round(float(20.0 * np.log10(max(out_peak, 1e-6))), 1),
        "active_rms_dbfs": round(float(20.0 * np.log10(max(out_rms, 1e-6))), 1),
    }


def _waveform_peaks(wav: Optional[np.ndarray], mode: str, n_bins: int = 340) -> List[List[float]]:
    if wav is None or wav.size < 4:
        return []
    w = np.asarray(wav, dtype=np.float32).reshape(-1)
    if mode == "raw":
        peak = float(np.max(np.abs(w)))
        w = (w / peak) if peak > 1e-6 else w
    else:
        w = np.clip(w / 0.90, -1.0, 1.0)
    n_b = min(n_bins, max(16, w.size // 4))
    edges = np.linspace(0, w.size, n_b + 1, dtype=np.int64)
    out: List[List[float]] = []
    for i in range(n_b):
        seg = w[edges[i] : max(edges[i] + 1, edges[i + 1])]
        out.append([round(float(np.min(seg)), 3), round(float(np.max(seg)), 3)])
    return out


def _apply_soft_onset_200hz(m27_200: np.ndarray, leading_sil_sec: float) -> np.ndarray:
    arr = np.asarray(m27_200, dtype=np.float64).copy()
    n200 = arr.shape[0]
    if n200 < 2:
        return arr
    if leading_sil_sec >= 0.02:
        ramp_sec = min(0.045, max(0.020, leading_sil_sec * 0.70))
        n_ramp = min(n200, max(4, int(round(ramp_sec / 0.005))))
        u = np.linspace(0.0, 1.0, n_ramp, dtype=np.float64)
        arr[:n_ramp, 18] *= 0.5 * (1.0 - np.cos(np.pi * u))
        half_r = max(2, n_ramp // 2)
        arr[:half_r, 23] = np.minimum(arr[:half_r, 23], 0.0)
    else:
        n_ramp = min(n200, 4)
        u = np.linspace(0.0, 1.0, n_ramp, dtype=np.float64)
        arr[:n_ramp, 18] *= 0.5 * (1.0 - np.cos(np.pi * u))
    return arr


def _enforce_release_modes_50hz(
    m27_50: np.ndarray,
    segments: List[SegmentEvent],
    role_by_idx: List[str],
    frame_t: np.ndarray,
) -> np.ndarray:
    arr = np.asarray(m27_50, dtype=np.float32).copy()
    for idx_s, seg in enumerate(segments):
        role = role_by_idx[idx_s] if idx_s < len(role_by_idx) else "normal"
        if role not in ("nasal_release", "lateral_release"):
            continue
        idxs = np.flatnonzero((frame_t >= seg.start_sec) & (frame_t < seg.end_sec))
        if idxs.size == 0:
            nearest = int(np.clip(np.floor(0.5 * (seg.start_sec + seg.end_sec) / 0.02), 0, arr.shape[0] - 1))
            idxs = np.array([nearest], dtype=np.int64)
        if role == "nasal_release":
            arr[idxs, 7] = np.maximum(arr[idxs, 7], 0.70)
            arr[idxs, 6] = np.minimum(arr[idxs, 6], 0.75)
            if idx_s > 0 and role_by_idx[idx_s - 1] == "closure":
                p_seg = segments[idx_s - 1]
                p_idx = np.flatnonzero((frame_t >= p_seg.start_sec) & (frame_t < p_seg.end_sec))
                if p_idx.size:
                    arr[p_idx, 7] = np.minimum(arr[p_idx, 7], -0.05)
        elif role == "lateral_release":
            arr[idxs, 16] = np.minimum(arr[idxs, 16], -0.90)
            arr[idxs, 15] = np.minimum(arr[idxs, 15], -0.18)
            if idx_s > 0 and role_by_idx[idx_s - 1] == "closure":
                p_seg = segments[idx_s - 1]
                p_idx = np.flatnonzero((frame_t >= p_seg.start_sec) & (frame_t < p_seg.end_sec))
                if p_idx.size:
                    arr[p_idx, 16] = np.maximum(arr[p_idx, 16], 0.0)
    return arr


def _apply_unreleased_zero_pressure_200hz(
    m27_200: np.ndarray,
    segments: List[SegmentEvent],
    role_by_idx: List[str],
) -> np.ndarray:
    arr = np.asarray(m27_200, dtype=np.float64).copy()
    n200 = arr.shape[0]
    if n200 < 2:
        return arr
    for idx_s, seg in enumerate(segments):
        role = role_by_idx[idx_s] if idx_s < len(role_by_idx) else "normal"
        if role not in ("closure", "hold", "normal") or ("\u031a" not in seg.ipa):
            continue
        val_d = validate_ipa_diacritics(seg.ipa)
        if "\u031a" in val_d["ignored_diacritics"]:  # type: ignore[operator]
            continue
        i0 = max(0, min(n200, int(round(seg.start_sec / 0.005))))
        i1 = max(i0 + 1, min(n200, int(round(seg.end_sec / 0.005))))
        seg_len = i1 - i0
        n_decay = max(4, int(round(seg_len * 0.55)))
        d0 = max(i0, i1 - n_decay)
        u = np.linspace(0.0, 1.0, i1 - d0, dtype=np.float64)
        arr[d0:i1, 18] *= 0.5 * (1.0 + np.cos(np.pi * u))
        ra0 = max(i0, i1 - max(3, int(round(seg_len * 0.40))))
        u_ra = np.linspace(0.0, 1.0, i1 - ra0, dtype=np.float64)
        arr[ra0:i1, 23] *= 0.5 * (1.0 + np.cos(np.pi * u_ra))
        nxt_is_sil = (idx_s + 1 >= len(segments)) or segments[idx_s + 1].is_sil
        if nxt_is_sil and i1 < n200:
            if idx_s + 1 < len(segments):
                sil_end = min(n200, int(round(segments[idx_s + 1].end_sec / 0.005)))
                has_more_speech = any(not s.is_sil for s in segments[idx_s + 2 :])
                if has_more_speech and (sil_end - i1) > 6:
                    ramp_k = min(5, (sil_end - i1) // 2)
                    arr[i1 : sil_end - ramp_k, 18] = 0.0
                    arr[i1 : sil_end - ramp_k, 23] = 0.0
                    u_up = np.linspace(0.0, 1.0, ramp_k, dtype=np.float64)
                    arr[sil_end - ramp_k : sil_end, 18] *= 0.5 * (1.0 - np.cos(np.pi * u_up))
                else:
                    arr[i1:sil_end, 18] = 0.0
                    arr[i1:sil_end, 23] = 0.0
            else:
                arr[i1:n200, 18] = 0.0
                arr[i1:n200, 23] = 0.0
    return arr


class IPASynthEngine:
    """High-level resident IPA synthesis engine (Python SDK & HTTP backend core)."""

    def __init__(self, config: Optional[EngineConfig] = None) -> None:
        self.cfg = config or EngineConfig()
        self.assets_dir = Path(self.cfg.assets_dir) if self.cfg.assets_dir else _default_assets_dir()
        self.device = str(self.cfg.device)
        self._model_lock = threading.Lock()
        self._kf_cache: Dict[str, Tuple[KeyframeTractModel27, Dict[str, Any]]] = {}
        self._voc_cache: Dict[str, Tuple[ConditionalHiFiGenerator27, Dict[str, Any]]] = {}

        canon_p = self.cfg.canonical_poses_path or (self.assets_dir / "canonical_ipa_poses.json")
        fb_p = self.cfg.fallback_poses_path or (self.assets_dir / "jd2_starter_fallback_poses.json")
        self.pose_bank = PoseBank(canonical_json=canon_p, fallback_json=fb_p)

        spk_enc_p = self.cfg.speaker_encoder_checkpoint or self._auto_find_asset(
            "vox2spk_lite_fp16.pt",
            "vox2spk_lite_int8.pt",
            "browser_spk_enc_fp16.pt",
            "browser_spk_enc_int8.pt",
            "spk_enc.pt",
        )
        spk_dir = self.cfg.speaker_store_dir or (self.assets_dir / "speakers")
        self.speaker_store = SpeakerProfileStore(spk_dir, encoder_weights=spk_enc_p, device=self.device)

        self.tract_backend = TractBackend(
            ptb_core_src=self.cfg.ptb_core_src,
            vtl_native_dir=self.cfg.vtl_native_dir,
            enable_native=self.cfg.enable_native_vtl,
        )

    def _auto_find_asset(self, *names: str) -> Optional[Path]:
        for name in names:
            p = self.assets_dir / name
            if p.is_file():
                return p
        return None

    def _auto_find_vocoder_candidates(self) -> List[Tuple[Path, str]]:
        out: List[Tuple[Path, str]] = []
        fixed = [
            ("tract2vox_lite_fp16.pt", "Tract2Vox-Lite · FP16 零底座声码器"),
            ("tract2vox_lite_int8.pt", "Tract2Vox-Lite · INT8 零底座声码器"),
            ("tract2vox_large.pt", "Tract2Vox-Large · 旗舰声码器"),
            ("browser_m27_stage5_fp16.pt", "Tract2Vox-Lite (legacy) · FP16 声码器"),
            ("browser_m27_stage5_int8.pt", "Tract2Vox-Lite (legacy) · INT8 声码器"),
            ("stage5_lite.pt", "Tract2Vox-Lite 声码器"),
        ]
        for fname, lbl in fixed:
            p = self.assets_dir / fname
            if p.is_file():
                out.append((p, lbl))
        if self.assets_dir.is_dir():
            for p in sorted(self.assets_dir.glob("tract2vox_lite_wip_*.pt")):
                out.append((p, f"Tract2Vox-Lite (WIP) · {p.stem}"))
        return out

    def list_models(self) -> Dict[str, Any]:
        kf_items: List[Dict[str, Any]] = [
            {"id": "baseline_only", "label": "仅异步物理基线 (α=0 · 零神经模型)", "path": "baseline_only", "size_mb": 0.0}
        ]
        seen = set()
        kf_candidates = [
            (self.cfg.kf_checkpoint, "自定义 IPA2Tract 检查点") if self.cfg.kf_checkpoint else (None, ""),
            (self.assets_dir / "ipa2tract_lite_fp16.pt", "IPA2Tract-Lite · FP16 协同动腔规划"),
            (self.assets_dir / "ipa2tract_lite_int8.pt", "IPA2Tract-Lite · INT8 极小模型"),
            (self.assets_dir / "kf2tract27_k2_fp16.pt", "IPA2Tract-Lite (KF2Tract27) · FP16 轻量模型"),
            (self.assets_dir / "kf2tract27_k2_int8.pt", "IPA2Tract-Lite (KF2Tract27) · INT8 极小模型"),
        ]
        for p, label in kf_candidates:
            if p and p.is_file() and str(p.resolve()) not in seen:
                seen.add(str(p.resolve()))
                sz = round(p.stat().st_size / (1024 ** 2), 2)
                kf_items.append({"id": p.name, "label": f"{label} ({sz:.1f} MB)", "path": str(p), "size_mb": sz})

        voc_items: List[Dict[str, Any]] = []
        voc_seen = set()
        env_voc = os.environ.get("KF_IPA_VOCODER_CKPT", "").strip()
        voc_candidates: List[Tuple[Optional[Path], str]] = [
            (self.cfg.vocoder_checkpoint, "自定义 Tract2Vox 声码器") if self.cfg.vocoder_checkpoint else (None, ""),
            (Path(env_voc), "环境变量指定 Tract2Vox 声码器") if env_voc else (None, ""),
        ]
        voc_candidates.extend(self._auto_find_vocoder_candidates())
        for p, label in voc_candidates:
            if p and p.is_file() and str(p.resolve()) not in voc_seen:
                voc_seen.add(str(p.resolve()))
                sz = round(p.stat().st_size / (1024 ** 2), 2)
                voc_items.append({"id": p.name, "label": f"{label} ({sz:.1f} MB)", "path": str(p), "size_mb": sz})

        return {
            "kf_models": kf_items,
            "vocoders": voc_items,
            "speaker_encoder_ready": self.speaker_store.encoder_available,
            "tract_backend": self.tract_backend.backend_mode,
            "native_vtl_available": self.tract_backend.native_available,
            "canonical_pose_count": len(self.pose_bank.poses),
            "fallback_pose_count": len(self.pose_bank.fallback_poses),
            "param_specs": M27_PARAM_SPECS,
        }

    def _resolve_kf_path(self, checkpoint: str) -> Optional[Path]:
        if checkpoint == "baseline_only":
            return None
        if checkpoint and checkpoint != "auto":
            p = Path(checkpoint)
            if p.is_file():
                return p
            p2 = self.assets_dir / checkpoint
            if p2.is_file():
                return p2
        if self.cfg.kf_checkpoint and self.cfg.kf_checkpoint.is_file():
            return self.cfg.kf_checkpoint
        return self._auto_find_asset(
            "ipa2tract_lite_fp16.pt",
            "ipa2tract_lite_int8.pt",
            "kf2tract27_k2_fp16.pt",
            "kf2tract27_k2_int8.pt",
        )

    def _resolve_vocoder_path(self, vocoder_ckpt: str) -> Optional[Path]:
        if vocoder_ckpt and vocoder_ckpt != "auto":
            p = Path(vocoder_ckpt)
            if p.is_file():
                return p
            p2 = self.assets_dir / vocoder_ckpt
            if p2.is_file():
                return p2
        if self.cfg.vocoder_checkpoint and self.cfg.vocoder_checkpoint.is_file():
            return self.cfg.vocoder_checkpoint
        env_voc = os.environ.get("KF_IPA_VOCODER_CKPT", "").strip()
        if env_voc and Path(env_voc).is_file():
            return Path(env_voc)
        cands = self._auto_find_vocoder_candidates()
        return cands[0][0] if cands else None

    def _get_kf_model(self, path: Path) -> Tuple[KeyframeTractModel27, Dict[str, Any]]:
        key = str(path.resolve())
        with self._model_lock:
            if key not in self._kf_cache:
                self._kf_cache[key] = load_kf2tract_model(path, device=self.device)
            return self._kf_cache[key]

    def _get_vocoder(self, path: Path) -> Tuple[ConditionalHiFiGenerator27, Dict[str, Any]]:
        key = str(path.resolve())
        with self._model_lock:
            if key not in self._voc_cache:
                self._voc_cache[key] = load_neural_vocoder(path, device=self.device)
            return self._voc_cache[key]

    # ------------------------------------------------------------------
    # Public Core APIs
    # ------------------------------------------------------------------
    def text_to_timeline(
        self,
        text: str,
        *,
        lang: str = "auto",
        bpm: float = 96.0,
        base_f0: float = 155.0,
        tone_sandhi: bool = True,
    ) -> Dict[str, Any]:
        return convert_text_to_timeline(
            text,
            lang=lang,
            bpm=float(bpm),
            base_f0=float(base_f0),
            tone_sandhi=bool(tone_sandhi),
        )

    def validate_ipa(self, ipa: str) -> Dict[str, Any]:
        v = validate_ipa_diacritics(ipa)
        return {
            "ok": True,
            "valid": bool(v["valid"]),
            "base": v["base"],
            "diacritics": v["diacritics"],
            "errors": v["errors"],
            "warnings": v["warnings"],
            "ignored_diacritics": sorted(v["ignored_diacritics"]),  # type: ignore[arg-type]
        }

    def resolve_keyframe_pose(
        self,
        keyframe: KeyframeSpec | Dict[str, Any],
        *,
        include_contour: bool = True,
        dirty_b_donor: str = "",
    ) -> Dict[str, Any]:
        """Resolve a keyframe to its 27-dim physical pose + organ mask + optional live sagittal contour."""
        kf = keyframe if isinstance(keyframe, KeyframeSpec) else KeyframeSpec.from_dict(keyframe)
        resolved = self.pose_bank.resolve_keyframe(kf, dirty_b_donor=dirty_b_donor)
        out: Dict[str, Any] = {
            "ok": True,
            "ipa": kf.ipa,
            "role": kf.role,
            "phonation": kf.phonation,
            "params": resolved["params"],
            "base_params": resolved["base_params"],
            "mask": resolved["mask"],
            "edited_params": resolved["edited_params"],
            "validation": {
                "valid": bool(resolved["validation"]["valid"]),
                "errors": list(resolved["validation"]["errors"]),
                "warnings": list(resolved["validation"]["warnings"]),
            },
            "param_specs": M27_PARAM_SPECS,
        }
        if include_contour:
            out["contour"] = self.tract_backend.extract_single_contour(resolved["m27_phys"])
        return out

    def preview_tract_contour(self, params: Dict[str, float] | np.ndarray) -> Dict[str, Any]:
        """Instant single-frame sagittal geometry preview for interactive vocal-tract dragging."""
        if isinstance(params, np.ndarray):
            arr = np.asarray(params, dtype=np.float32).reshape(27)
        else:
            arr = self.pose_bank.resolve_keyframe(KeyframeSpec(ipa="ə", phonation="modal"))["m27_phys"].copy()
            for name, val in params.items():
                idx = M27_INDEX.get(str(name))
                if idx is not None and val is not None:
                    arr[idx] = float(np.clip(float(val), M27_MIN[idx], M27_MAX[idx]))
        contour = self.tract_backend.extract_single_contour(arr)
        contour["ok"] = True
        contour["params"] = {name: round(float(arr[i]), 4) for i, name in enumerate(M27_NAMES)}
        return contour

    def _resolve_speaker_embedding(self, req: SynthRequest) -> np.ndarray:
        if req.speaker_embedding is not None and len(req.speaker_embedding) == 512:
            arr = np.asarray(req.speaker_embedding, dtype=np.float32)
            n = float(np.linalg.norm(arr))
            return (arr / n) if n > 1e-8 else arr
        if req.speaker_profile:
            return self.speaker_store.load_embedding(req.speaker_profile)
        if req.ref_wav and Path(req.ref_wav).is_file():
            emb, _ = self.speaker_store.extract_embedding(Path(req.ref_wav))
            return emb
        # If any saved profile exists, fall back to the first one; otherwise use a deterministic neutral unit vector
        profs = self.speaker_store.list_profiles()
        if profs:
            return self.speaker_store.load_embedding(profs[0]["id"])
        vec = np.ones(512, dtype=np.float32)
        return vec / float(np.linalg.norm(vec))

    def synthesize(
        self,
        request: SynthRequest | Dict[str, Any],
        *,
        out_dir: Optional[Path] = None,
    ) -> Dict[str, Any]:
        """Run full IPA-keyframe -> 50 Hz M27 trajectory -> audio & animation synthesis in memory."""
        t0 = time.perf_counter()
        req = request if isinstance(request, SynthRequest) else SynthRequest.from_dict(request)
        if not req.keyframes:
            raise ValueError("keyframes 列表不能为空")

        segments: List[SegmentEvent] = []
        resolved_by_idx: List[Dict[str, Any]] = []
        role_by_idx: List[str] = []
        f0_knots_t: List[float] = []
        f0_knots_hz: List[float] = []
        diacritic_errors: List[str] = []
        diacritic_warnings: List[str] = []

        cursor = 0.0
        for idx, kf in enumerate(req.keyframes):
            res_kf = self.pose_bank.resolve_keyframe(kf, dirty_b_donor=req.dirty_b_donor)
            seg, _ = self.pose_bank.build_segment_event(kf, cursor, idx)
            segments.append(seg)
            resolved_by_idx.append(res_kf)
            role_by_idx.append(kf.role)
            for msg in res_kf["validation"]["errors"]:
                if msg not in diacritic_errors:
                    diacritic_errors.append(msg)
            for msg in res_kf["validation"]["warnings"]:
                if msg not in diacritic_warnings:
                    diacritic_warnings.append(msg)
            if not seg.is_sil:
                f0_knots_t.append(cursor + 0.5 * seg.duration)
                f0_knots_hz.append(kf.f0_hz)
            cursor += seg.duration

        total_sec = cursor
        n_frames = max(4, int(round(total_sec / 0.02)))
        frame_t = (np.arange(n_frames, dtype=np.float32) + 0.5) * 0.02

        if req.f0_points:
            pts = sorted(req.f0_points, key=lambda p: p.t)
            pts_t = np.asarray([p.t for p in pts], dtype=np.float32)
            pts_hz = np.asarray([p.hz for p in pts], dtype=np.float32)
            f0_50hz = np.interp(frame_t, pts_t, pts_hz).astype(np.float32)
            if n_frames >= 5:
                log_f0 = np.log(np.clip(f0_50hz, 45.0, 580.0))
                sm = log_f0.copy()
                sm[1:-1] = 0.22 * log_f0[:-2] + 0.56 * log_f0[1:-1] + 0.22 * log_f0[2:]
                f0_50hz = np.exp(sm).astype(np.float32)
        elif f0_knots_t:
            f0_50hz = np.interp(frame_t, np.asarray(f0_knots_t, dtype=np.float32), np.asarray(f0_knots_hz, dtype=np.float32)).astype(np.float32)
        else:
            f0_50hz = np.full(n_frames, 130.0, dtype=np.float32)
        f0_norm = normalize_f0_m27(f0_50hz)

        def _pose_lookup(seg: SegmentEvent) -> np.ndarray:
            k_i = int(seg.raw_label.split("_")[1])
            return resolved_by_idx[k_i]["kf26_norm"]

        def _mask_override(seg: SegmentEvent, _default_w26: np.ndarray) -> np.ndarray:
            k_i = int(seg.raw_label.split("_")[1])
            return resolved_by_idx[k_i]["w_mask_26"]

        cond, x_base, w_mask, _ = build_condition_from_segments(
            segments,
            n_frames,
            f0_norm,
            _pose_lookup,
            mask_override=_mask_override,
        )
        m27_base_phys = denormalize_m27(kf26_and_f0_to_m27(x_base, f0_norm))

        kf_path = self._resolve_kf_path(req.checkpoint)
        used_model_label = "baseline_only (异步物理基线)"
        if kf_path is not None:
            model, meta = self._get_kf_model(kf_path)
            with torch.no_grad():
                xh, _ = model(
                    torch.from_numpy(cond[None, :, :]).to(self.device),
                    torch.from_numpy(x_base[None, :, :]).to(self.device),
                    valid_mask=None,
                    alpha=req.alpha,
                )
                x_hat_np = xh[0].float().cpu().numpy()
            m27_model_phys = denormalize_m27(kf26_and_f0_to_m27(x_hat_np, f0_norm))
            used_model_label = f"{kf_path.name} (step={meta.get('step', 'lite')})"
        else:
            m27_model_phys = m27_base_phys.copy()

        m27_model_phys = _enforce_release_modes_50hz(m27_model_phys, segments, role_by_idx, frame_t)
        m27_base_phys = _enforce_release_modes_50hz(m27_base_phys, segments, role_by_idx, frame_t)

        leading_sil_sec = 0.0
        for seg in segments:
            if seg.is_sil:
                leading_sil_sec += seg.duration
            else:
                break

        wav_m_48k: Optional[np.ndarray] = None
        wav_b_48k: Optional[np.ndarray] = None
        audio_meta_m: Dict[str, Any] = {"gain_mode": req.gain_mode, "gain_db": 0.0}
        audio_meta_b: Dict[str, Any] = {"gain_mode": req.gain_mode, "gain_db": 0.0}
        if req.render_r21 and self.tract_backend.native_available:
            m27_m_200 = _apply_unreleased_zero_pressure_200hz(
                _apply_soft_onset_200hz(qta_filter_m27_50_to_200(m27_model_phys), leading_sil_sec),
                segments,
                role_by_idx,
            )
            m27_b_200 = _apply_unreleased_zero_pressure_200hz(
                _apply_soft_onset_200hz(qta_filter_m27_50_to_200(m27_base_phys), leading_sil_sec),
                segments,
                role_by_idx,
            )
            raw_m = self.tract_backend.synthesize_r21_48k(m27_m_200, tube_hz=100)
            raw_b = self.tract_backend.synthesize_r21_48k(m27_b_200, tube_hz=100)
            if raw_m is not None:
                wav_m_48k, audio_meta_m = _apply_output_gain(raw_m, req.gain_mode, sr=SAMPLE_RATE_48K)
            if raw_b is not None:
                wav_b_48k, audio_meta_b = _apply_output_gain(raw_b, req.gain_mode, sr=SAMPLE_RATE_48K)

        wav_neural_16k: Optional[np.ndarray] = None
        vocoder_label: Optional[str] = None
        if req.use_neural_vocoder:
            voc_path = self._resolve_vocoder_path(req.vocoder_checkpoint)
            if voc_path is not None:
                voc, voc_meta = self._get_vocoder(voc_path)
                spk_emb = self._resolve_speaker_embedding(req)
                m27_norm = normalize_m27(m27_model_phys.astype(np.float32))
                with torch.no_grad():
                    wav_hat = voc(
                        torch.from_numpy(m27_norm[None, :, :]).to(self.device),
                        torch.from_numpy(spk_emb[None, :]).to(self.device),
                    )[0].float().cpu().numpy()
                peak = float(np.max(np.abs(wav_hat))) + 1e-8
                if peak > 0.98:
                    wav_hat = wav_hat * (0.95 / peak)
                wav_neural_16k = wav_hat.astype(np.float32)
                vocoder_label = f"{voc_path.name} (step={voc_meta.get('step', 'lite')})"

        anim = self.tract_backend.extract_animation(m27_model_phys, fps=req.animation_fps) if req.render_animation else None

        curve_cols = {
            "JA": 3, "LP": 4, "LD": 5, "VO": 7,
            "TCX": 8, "TCY": 9, "TTX": 10, "TTY": 11, "TS3": 16,
            "F0": 17, "PR": 18, "XB": 19, "CA": 21, "LAG": 22, "RA": 23, "FL": 25, "SHIM": 26,
        }
        primary_wav = wav_m_48k if wav_m_48k is not None else wav_neural_16k
        curves = {
            "t": [round(float(x), 3) for x in frame_t],
            "model": {k: [round(float(v), 4) for v in m27_model_phys[:, c]] for k, c in curve_cols.items()},
            "baseline": {k: [round(float(v), 4) for v in m27_base_phys[:, c]] for k, c in curve_cols.items()},
            "segments": [
                {
                    "ipa": s.ipa,
                    "start": round(s.start_sec, 3),
                    "end": round(s.end_sec, 3),
                    "cl": s.is_closure,
                    "rel": s.is_release,
                    "edited": bool(resolved_by_idx[i]["edited_params"]),
                }
                for i, s in enumerate(segments)
            ],
            "waveform_model": _waveform_peaks(primary_wav, req.gain_mode),
            "waveform_base": _waveform_peaks(wav_b_48k, req.gain_mode),
            "audio_meta_model": audio_meta_m,
            "audio_meta_base": audio_meta_b,
        }

        files_written: Dict[str, Optional[str]] = {
            "model_r21_wav": None,
            "baseline_r21_wav": None,
            "neural_wav": None,
        }
        if out_dir is not None:
            out_dir = Path(out_dir)
            out_dir.mkdir(parents=True, exist_ok=True)
            if wav_m_48k is not None:
                sf.write(str(out_dir / "model_r21_48k.wav"), wav_m_48k, SAMPLE_RATE_48K)
                files_written["model_r21_wav"] = "model_r21_48k.wav"
            if wav_b_48k is not None:
                sf.write(str(out_dir / "baseline_r21_48k.wav"), wav_b_48k, SAMPLE_RATE_48K)
                files_written["baseline_r21_wav"] = "baseline_r21_48k.wav"
            if wav_neural_16k is not None:
                sf.write(str(out_dir / "model_neural_16k.wav"), wav_neural_16k, SAMPLE_RATE_16K)
                files_written["neural_wav"] = "model_neural_16k.wav"
            np.savez_compressed(
                out_dir / "controls_m27.npz",
                m27_model=m27_model_phys.astype(np.float32),
                m27_baseline=m27_base_phys.astype(np.float32),
                w_mask=w_mask.astype(np.float32),
            )
            if anim is not None:
                (out_dir / "animation.json").write_text(json.dumps(anim, ensure_ascii=False), encoding="utf-8")
            (out_dir / "curves.json").write_text(json.dumps(curves, ensure_ascii=False), encoding="utf-8")

        summary = {
            "ok": True,
            "model_label": used_model_label,
            "vocoder_label": vocoder_label,
            "tract_backend": self.tract_backend.backend_mode,
            "alpha": req.alpha,
            "gain_mode": req.gain_mode,
            "audio_meta": audio_meta_m,
            "audio_meta_base": audio_meta_b,
            "duration_sec": round(total_sec, 3),
            "n_frames": n_frames,
            "edited_keyframe_count": sum(1 for r in resolved_by_idx if r["edited_params"]),
            "model_r21_wav": files_written["model_r21_wav"],
            "baseline_r21_wav": files_written["baseline_r21_wav"],
            "neural_wav": files_written["neural_wav"],
            "wall_sec": round(time.perf_counter() - t0, 3),
            "max_tract_minus_base": round(float(np.max(np.abs(m27_model_phys[:, :17] - m27_base_phys[:, :17]))), 4),
            "diacritic_errors": diacritic_errors,
            "diacritic_warnings": diacritic_warnings,
        }
        if out_dir is not None:
            (out_dir / "result.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")

        return {
            "summary": summary,
            "m27_model": m27_model_phys,
            "m27_baseline": m27_base_phys,
            "w_mask": w_mask,
            "curves": curves,
            "animation": anim,
            "wav_model_48k": wav_m_48k,
            "wav_baseline_48k": wav_b_48k,
            "wav_neural_16k": wav_neural_16k,
            "resolved_keyframes": [
                {
                    "index": i,
                    "ipa": req.keyframes[i].ipa,
                    "params": r["params"],
                    "mask": r["mask"],
                    "edited_params": r["edited_params"],
                }
                for i, r in enumerate(resolved_by_idx)
            ],
        }


__all__ = ["EngineConfig", "IPASynthEngine"]
