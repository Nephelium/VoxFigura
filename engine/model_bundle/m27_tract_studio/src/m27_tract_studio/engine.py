"""Resident, CPU-safe M27 dynamic vocal-tract & glottis trajectory reconstruction engine."""
from __future__ import annotations

from collections import OrderedDict
from datetime import datetime
import json
import os
from pathlib import Path
import re
import threading
import time
from typing import Any, Callable, Dict, List, Optional, Tuple, Union
import uuid

import numpy as np
from scipy.signal import resample_poly
import soundfile as sf
import torch
import torch.nn.functional as F

from .config import (
    VALID_CHECKPOINTS,
    TractStudioConfig,
    ensure_runtime_paths,
    inspect_available_checkpoints,
    pick_motor_checkpoint,
    pick_neural_checkpoint_path,
)
from .denoise import denoise_audio_16k, load_audio_bytes_16k

ALLOWED_EXTS = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac", ".webm", ".mp4"}
SAFE_JOB_RE = re.compile(r"^[A-Za-z0-9_.\-]+$")


def _interp_50_to_200(arr_50: np.ndarray) -> np.ndarray:
    """Linear 50 Hz -> 200 Hz upsampling preserving rapid consonant closures & bursts."""
    n50 = arr_50.shape[0]
    n200 = n50 * 4
    if n50 <= 1:
        return np.repeat(arr_50, n200, axis=0)
    t50 = (np.arange(n50, dtype=np.float64) + 0.5) / 50.0
    t200 = (np.arange(n200, dtype=np.float64) + 0.5) / 200.0
    out = np.empty((n200, arr_50.shape[1]), dtype=np.float64)
    for d in range(arr_50.shape[1]):
        out[:, d] = np.interp(t200, t50, arr_50[:, d])
    return out


def _stabilize_m27(arr_50: np.ndarray) -> np.ndarray:
    out = np.array(arr_50, dtype=np.float64, copy=True)
    if out.shape[0] >= 3:
        m_mid = out[1:-1, :17].copy()
        out[1:-1, :17] = 0.25 * out[:-2, :17] + 0.50 * m_mid + 0.25 * out[2:, :17]
    out[:, 18] = np.minimum(out[:, 18], 14000.0)
    return out


def _glottis_summary(m27_phys: np.ndarray) -> str:
    act = (m27_phys[:, 18] > 1800.0) & (m27_phys[:, 23] > 0.25)
    rows = m27_phys[act] if np.any(act) else m27_phys
    return (
        f"F0均值 {float(np.mean(rows[:, 17])):.0f} Hz · "
        f"PR {float(np.mean(rows[:, 18])):.0f} dPa · "
        f"XB {float(np.mean(rows[:, 19])):.3f}/XT {float(np.mean(rows[:, 20])):.3f} · "
        f"CA {float(np.mean(rows[:, 21])):.3f} · "
        f"LAG {float(np.mean(rows[:, 22])):.2f} · "
        f"PS {float(np.mean(rows[:, 24])):.2f} · "
        f"FL {float(np.mean(rows[:, 25])):.0f} · "
        f"SHIM {float(np.mean(rows[:, 26])):.0f}"
    )


def _write_wav_atomic(path: Path, wav: np.ndarray, sr: int) -> None:
    tmp = path.with_suffix(".tmp.wav")
    sf.write(str(tmp), wav, int(sr), format="WAV", subtype="PCM_16")
    os.replace(tmp, path)


def _write_json_atomic(path: Path, payload: Dict[str, Any]) -> None:
    tmp = path.with_suffix(".tmp.json")
    tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def _find_input_file(job_dir: Path, prefix: str) -> Optional[Path]:
    for cand in sorted(job_dir.glob(f"{prefix}.*")):
        if cand.is_file():
            return cand
    return None


def _synthesize_neural_chunked(
    gen: Any,
    m27_norm_t: torch.Tensor,
    e_spk: torch.Tensor,
    hop_samples: int = 320,
    chunk_frames: int = 500,
    overlap_frames: int = 8,
) -> np.ndarray:
    n_frames = m27_norm_t.shape[1]
    if n_frames <= chunk_frames + 100:
        return gen(m27_norm_t, e_spk).squeeze(0).cpu().numpy().astype(np.float32)

    fade_s = overlap_frames * hop_samples
    fade_w = (0.5 - 0.5 * np.cos(np.pi * np.linspace(0.0, 1.0, fade_s))).astype(np.float32)
    out: Optional[np.ndarray] = None
    pos = 0
    while pos < n_frames:
        s_idx = max(0, pos - overlap_frames) if pos > 0 else 0
        e_idx = min(n_frames, pos + chunk_frames)
        y_seg = gen(m27_norm_t[:, s_idx:e_idx, :], e_spk).squeeze(0).cpu().numpy().astype(np.float32)
        if out is None or pos == 0:
            out = y_seg
        else:
            out[-fade_s:] = out[-fade_s:] * (1.0 - fade_w) + y_seg[:fade_s] * fade_w
            out = np.concatenate([out, y_seg[fade_s:]])
        if e_idx >= n_frames:
            break
        pos += chunk_frames
    assert out is not None
    return out[: n_frames * hop_samples]


def _rewrite_audio_url(val: Any, job_id: str, url_prefix: str) -> Any:
    if not isinstance(val, str) or not val:
        return val
    base = val.split("?", 1)[0]
    fname = base.rsplit("/", 1)[-1]
    dl = "?download=1" if "download=1" in val else ""
    prefix = url_prefix.rstrip("/")
    return f"{prefix}/{job_id}/audio/{fname}{dl}"


def rewrite_job_record_urls(
    rec: Dict[str, Any],
    *,
    job_dir: Optional[Path] = None,
    url_prefix: str = "/api/jobs",
) -> Dict[str, Any]:
    """Return a shallow-copied job dict whose URLs match the standalone REST API routes."""
    out = dict(rec)
    jid = str(out.get("job_id", ""))
    if not jid:
        return out
    for key in ("ref_url", "syn_url", "download_url", "neural_url", "neural_download_url", "speaker_ref_url", "raw_ref_url"):
        if key in out and out[key]:
            out[key] = _rewrite_audio_url(out[key], jid, url_prefix)
    if job_dir is not None and not out.get("raw_ref_url") and (job_dir / "raw_16k.wav").is_file():
        out["raw_ref_url"] = f"{url_prefix.rstrip('/')}/{jid}/audio/raw_16k.wav"
    return out


class TractReconstructionEngine:
    """Self-contained, resident CPU/GPU engine for M27 dynamic vocal-tract reconstruction."""

    def __init__(
        self,
        config: Optional[TractStudioConfig] = None,
        *,
        train_root: Optional[Union[str, Path]] = None,
        run_root: Optional[Union[str, Path]] = None,
        work_dir: Optional[Union[str, Path]] = None,
        hf_cache_dir: Optional[Union[str, Path]] = None,
        ptb_root: Optional[Union[str, Path]] = None,
        device: str = "cpu",
        anim_cache_size: int = 24,
    ) -> None:
        if config is None:
            kwargs: Dict[str, Any] = {"default_device": device}
            if train_root is not None:
                kwargs["train_root"] = Path(train_root)
            if run_root is not None:
                kwargs["run_root"] = Path(run_root)
            if work_dir is not None:
                kwargs["work_dir"] = Path(work_dir)
            if hf_cache_dir is not None:
                kwargs["hf_cache_dir"] = Path(hf_cache_dir)
            if ptb_root is not None:
                kwargs["ptb_root"] = Path(ptb_root)
            self.config = TractStudioConfig(**kwargs)
        else:
            self.config = config

        self.config.work_dir.mkdir(parents=True, exist_ok=True)
        ensure_runtime_paths(self.config)

        self._infer_lock = threading.Lock()
        self._anim_lock = threading.Lock()
        self._anim_engine: Optional[Any] = None
        self._anim_cache: OrderedDict[Tuple[str, int, int], bytes] = OrderedDict()
        self._anim_cache_size = max(4, int(anim_cache_size))

        self._pitch: Optional[Any] = None
        self._wavlm_cache: Dict[str, Any] = {}
        self._pr_cache: Dict[str, Any] = {}
        self._motor_cache: Dict[Tuple[str, str, str], Tuple[Any, int, str]] = {}
        self._spk_cache: Dict[str, Any] = {}
        self._neural_cache: Dict[Tuple[str, str], Tuple[Any, Dict[str, Any]]] = {}

    # ------------------------------------------------------------------
    # Inspection & Lifecycle
    # ------------------------------------------------------------------
    def diagnostics(self) -> Dict[str, Any]:
        return {
            "ok": True,
            "train_root": str(self.config.train_root),
            "run_root": str(self.config.run_root),
            "work_dir": str(self.config.work_dir),
            "ptb_root": str(self.config.ptb_root),
            "default_checkpoint": self.config.default_checkpoint,
            "default_device": self.config.default_device,
            "checkpoints": inspect_available_checkpoints(self.config.run_root),
            "loaded_models": {
                "wavlm_devices": sorted(self._wavlm_cache.keys()),
                "pr_devices": sorted(self._pr_cache.keys()),
                "motor_keys": [f"{d}:{s}/{f}" for (d, s, f) in sorted(self._motor_cache.keys())],
                "neural_keys": [f"{d}:{Path(p).parent.name}/{Path(p).name}" for (d, p) in sorted(self._neural_cache.keys())],
                "anim_engine_open": self._anim_engine is not None,
            },
            "job_count": len(self.list_jobs()),
        }

    def unload_models(self) -> None:
        """Release cached PyTorch models and native JD2 engine handles."""
        with self._infer_lock:
            self._wavlm_cache.clear()
            self._pr_cache.clear()
            self._motor_cache.clear()
            self._spk_cache.clear()
            self._neural_cache.clear()
            self._pitch = None
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        with self._anim_lock:
            if self._anim_engine is not None:
                try:
                    self._anim_engine.close()
                except Exception:
                    pass
                self._anim_engine = None
            self._anim_cache.clear()

    close = unload_models

    # ------------------------------------------------------------------
    # Denoising
    # ------------------------------------------------------------------
    def _load_audio_any(self, audio_input: Union[str, Path, bytes, np.ndarray], *, filename: str = "upload.wav") -> Tuple[np.ndarray, Optional[bytes]]:
        from tt3.inference import load_audio_16k

        if isinstance(audio_input, np.ndarray):
            arr = np.asarray(audio_input, dtype=np.float32).reshape(-1)
            arr = np.nan_to_num(arr, nan=0.0, posinf=0.0, neginf=0.0)
            if len(arr) < 800:
                raise ValueError("音频有效时长不足 0.05 秒")
            if len(arr) > int(round(self.config.max_duration_sec * 16000)):
                raise ValueError(f"音频时长超过 {self.config.max_duration_sec:.1f}s 上限")
            return np.ascontiguousarray(arr, dtype=np.float32), None
        if isinstance(audio_input, (bytes, bytearray)):
            raw = bytes(audio_input)
            if len(raw) > self.config.max_upload_bytes:
                raise ValueError(f"上传音频超过 {self.config.max_upload_bytes // (1024 * 1024)} MB 上限")
            return load_audio_bytes_16k(raw, filename=filename, max_duration_sec=self.config.max_duration_sec), raw
        p = Path(audio_input)
        return load_audio_16k(p, max_duration_sec=self.config.max_duration_sec), p.read_bytes()

    def denoise_audio(
        self,
        audio_input: Union[str, Path, bytes, np.ndarray],
        *,
        filename: str = "upload.wav",
        preset: str = "standard",
    ) -> Dict[str, Any]:
        """Run phonetics-preserving speech denoising and return raw & cleaned 16 kHz waveforms + metrics."""
        raw_16k, _ = self._load_audio_any(audio_input, filename=filename)
        denoised_16k, metrics = denoise_audio_16k(raw_16k, sr=16000, config=preset)
        return {
            "filename": Path(filename or "upload.wav").name,
            "sr": 16000,
            "dur_sec": round(len(raw_16k) / 16000.0, 3),
            "raw_16k": raw_16k,
            "denoised_16k": denoised_16k,
            "metrics": metrics,
        }

    # ------------------------------------------------------------------
    # Lazy Model Loaders (protected by self._infer_lock)
    # ------------------------------------------------------------------
    def _get_pitch(self):
        if self._pitch is None:
            from tt3.m27_contract import F0_MAX_M27, F0_MIN_M27
            from tt3.pitch import SwiftF0Extractor

            self._pitch = SwiftF0Extractor(fmin=F0_MIN_M27, fmax=F0_MAX_M27)
        return self._pitch

    def _get_wavlm(self, device: torch.device):
        key = str(device)
        if key not in self._wavlm_cache:
            from tt3.models import FrozenWavLM

            self._wavlm_cache[key] = FrozenWavLM(cache_dir=self.config.hf_cache_dir).to(device).eval()
        return self._wavlm_cache[key]

    def _get_pr_encoder(self, device: torch.device):
        from tt3.inference import safe_torch_load
        from tt3.m27_models import PressureEncoder27

        key = str(device)
        if key not in self._pr_cache:
            pr_path = self.config.run_root / "pr_encoder" / "best.pt"
            if not pr_path.is_file():
                pr_path = self.config.run_root / "pr_encoder" / "latest.pt"
            if not pr_path.is_file():
                raise FileNotFoundError(f"未找到 PR-Encoder 检查点于 {self.config.run_root / 'pr_encoder'}")
            ckpt = safe_torch_load(pr_path, map_location=device)
            model = PressureEncoder27().to(device).eval()
            model.load_state_dict(ckpt["model"])
            self._pr_cache[key] = model
        return self._pr_cache[key]

    def _get_motor(self, device: torch.device, pref: str) -> Tuple[Any, str, int, str]:
        from tt3.inference import safe_torch_load
        from tt3.m27_models import DualBranchMotor27

        stage, path = pick_motor_checkpoint(self.config.run_root, pref)
        key = (str(device), stage, path.name)
        if key not in self._motor_cache:
            ckpt = safe_torch_load(path, map_location=device)
            model = DualBranchMotor27().to(device).eval()
            model.load_state_dict(ckpt["model"])
            step = int(ckpt.get("step", 0))
            self._motor_cache[key] = (model, step, path.name)
        model, step, fname = self._motor_cache[key]
        return model, stage, step, fname

    def _get_speaker_encoder(self, device: torch.device):
        key = str(device)
        if key not in self._spk_cache:
            from tt3.neural_synth_models import FrozenSpeakerEncoder

            self._spk_cache[key] = FrozenSpeakerEncoder(cache_dir=self.config.hf_cache_dir).to(device).eval()
        return self._spk_cache[key]

    def _get_neural_generator(self, device: torch.device, pref: str) -> Tuple[Any, Dict[str, Any]]:
        from tt3.inference import safe_torch_load
        from tt3.neural_synth_models import ConditionalHiFiGenerator27

        n_path = pick_neural_checkpoint_path(self.config.run_root, pref)
        key = (str(device), str(n_path.resolve()))
        if key not in self._neural_cache:
            ckpt = safe_torch_load(n_path, map_location=device)
            gen = ConditionalHiFiGenerator27.from_arch_config(ckpt.get("generator_config")).to(device).eval()
            gen.load_state_dict(ckpt["generator"])
            meta = {
                "stage": n_path.parent.name,
                "arch": gen.arch_name,
                "step": int(ckpt.get("step", 0)),
                "file": n_path.name,
            }
            self._neural_cache[key] = (gen, meta)
        return self._neural_cache[key]

    # ------------------------------------------------------------------
    # Core Inversion & Dual Synthesis
    # ------------------------------------------------------------------
    def _run_pipeline_in_dir(
        self,
        job_dir: Path,
        *,
        wav_raw_16k: np.ndarray,
        orig_filename: str,
        checkpoint: str,
        device_pref: str,
        denoise: bool,
        denoise_preset: str,
        speaker_ref_path: Optional[Path] = None,
        orig_spk_filename: str = "",
        created_at: Optional[str] = None,
        resynthed_at: Optional[str] = None,
        url_prefix: str = "/api/jobs",
    ) -> Dict[str, Any]:
        from tt3.constants import CONTROL_HZ_50, SAMPLE_RATE_16K, SAMPLE_RATE_48K, WAVLM_HOP_SAMPLES
        from tt3.glottis27_generator import M27_NAMES, M27Synthesizer
        from tt3.inference import load_audio_16k, plan_silence_chunks, select_inference_device
        from tt3.m27_contract import assemble_m27_norm, denormalize_m27, normalize_f0_m27, normalize_m27
        from tt3.m27_models import normalize_wavlm_l6_target
        from tt3.playback import normalize_playback

        t0 = time.perf_counter()
        job_id = job_dir.name
        samples_per_frame_48k = SAMPLE_RATE_48K // CONTROL_HZ_50  # 960 samples

        denoise_info: Optional[Dict[str, Any]] = None
        wav_for_model = wav_raw_16k
        if denoise:
            wav_cleaned_16k, denoise_info = denoise_audio_16k(wav_raw_16k, sr=SAMPLE_RATE_16K, config=denoise_preset)
            wav_for_model = wav_cleaned_16k

        n_frames = max(1, len(wav_for_model) // WAVLM_HOP_SAMPLES)
        wav_16k = np.ascontiguousarray(wav_for_model[: n_frames * WAVLM_HOP_SAMPLES], dtype=np.float32)
        wav_raw_trim = np.ascontiguousarray(wav_raw_16k[: n_frames * WAVLM_HOP_SAMPLES], dtype=np.float32)
        dur_sec = round(len(wav_16k) / SAMPLE_RATE_16K, 3)

        ckpt_choice = checkpoint if checkpoint in VALID_CHECKPOINTS else self.config.default_checkpoint
        with self._infer_lock:
            device = select_inference_device(device_pref)
            use_bf16 = device.type == "cuda"

            wavlm = self._get_wavlm(device)
            pr_encoder = self._get_pr_encoder(device)
            motor, motor_stage, motor_step, motor_file = self._get_motor(device, ckpt_choice)
            pitch = self._get_pitch()

            chunks_plan = plan_silence_chunks(wav_16k, max_chunk_sec=self.config.max_chunk_sec)
            pad_f = 20
            m27_parts: List[np.ndarray] = []

            for ch in chunks_plan:
                sf_i = ch["start_16k"] // WAVLM_HOP_SAMPLES
                ef_i = ch["end_16k"] // WAVLM_HOP_SAMPLES
                ctx_s = max(0, sf_i - pad_f)
                ctx_e = min(n_frames, ef_i + pad_f)
                wav_ctx = np.ascontiguousarray(
                    wav_16k[ctx_s * WAVLM_HOP_SAMPLES : ctx_e * WAVLM_HOP_SAMPLES],
                    dtype=np.float32,
                )
                ctx_len = ctx_e - ctx_s

                f0_hz, _ = pitch.extract_50hz(wav_ctx, num_frames=ctx_len)
                f0_norm = normalize_f0_m27(f0_hz)
                wav_t = torch.from_numpy(wav_ctx).unsqueeze(0).to(device)
                mask_t = torch.ones((1, ctx_len), dtype=torch.float32, device=device)
                f0_t = torch.from_numpy(f0_norm).view(1, ctx_len, 1).to(device)

                with torch.inference_mode():
                    w25 = wavlm(wav_t, mask_t, use_bf16=use_bf16)
                    pr_hat = pr_encoder(w25, wav_t, mask_t)
                    tract_hat, glot_hat = motor(w25, wav_t, f0_t, pr_hat, mask_t)
                    m27_norm = assemble_m27_norm(tract_hat, f0_t, pr_hat, glot_hat)
                    m27_ctx = denormalize_m27(m27_norm.squeeze(0).cpu().numpy())

                m27_parts.append(m27_ctx[sf_i - ctx_s : ef_i - ctx_s])

            m27_all_50 = np.concatenate(m27_parts, axis=0)

            overlap_f = 2
            fade_48k = int(0.030 * SAMPLE_RATE_48K)
            fade_w = (0.5 - 0.5 * np.cos(np.pi * np.linspace(0.0, 1.0, fade_48k))).astype(np.float64)

            wav48_out: Optional[np.ndarray] = None
            with M27Synthesizer(section_count=65) as synth:
                for ci, ch in enumerate(chunks_plan):
                    sf_i = ch["start_16k"] // WAVLM_HOP_SAMPLES
                    ef_i = ch["end_16k"] // WAVLM_HOP_SAMPLES
                    lb = overlap_f if (ci > 0 and sf_i >= overlap_f) else 0
                    seg_50 = m27_all_50[sf_i - lb : ef_i]
                    syn = synth.synthesize_200hz(
                        _interp_50_to_200(seg_50),
                        perturb_seed=700 + ci,
                        tube_hz=self.config.tube_hz,
                        return_48k=True,
                    )
                    if syn is None or syn[0] is None:
                        syn = synth.synthesize_200hz(
                            _interp_50_to_200(_stabilize_m27(seg_50)),
                            perturb_seed=700 + ci,
                            tube_hz=self.config.tube_hz,
                            return_48k=True,
                        )
                    if syn is None or syn[0] is None:
                        raise RuntimeError(f"分段 {ci + 1}/{len(chunks_plan)} R21 物理声管合成失败")
                    chunk_48k = syn[0].astype(np.float64)
                    if wav48_out is None or lb == 0:
                        wav48_out = chunk_48k
                    else:
                        lead = lb * samples_per_frame_48k
                        f_len = min(fade_48k, lead, len(wav48_out))
                        fw = fade_w[:f_len] if f_len == fade_48k else (
                            0.5 - 0.5 * np.cos(np.pi * np.linspace(0.0, 1.0, f_len))
                        )
                        wav48_out[-f_len:] = wav48_out[-f_len:] * (1.0 - fw) + chunk_48k[lead - f_len : lead] * fw
                        wav48_out = np.concatenate([wav48_out, chunk_48k[lead:]])

            assert wav48_out is not None
            wav48_f32 = wav48_out.astype(np.float32)

            eval_f = min(n_frames, 12 * CONTROL_HZ_50)
            eval_s = eval_f * WAVLM_HOP_SAMPLES
            syn_16k = resample_poly(wav48_f32[: eval_f * samples_per_frame_48k], 1, 3).astype(np.float32)
            if len(syn_16k) < eval_s:
                syn_16k = np.pad(syn_16k, (0, eval_s - len(syn_16k)))
            else:
                syn_16k = syn_16k[:eval_s]

            with torch.inference_mode():
                e_mask = torch.ones((1, eval_f), dtype=torch.float32, device=device)
                w25_r = wavlm(torch.from_numpy(wav_16k[:eval_s]).unsqueeze(0).to(device), e_mask, use_bf16=use_bf16)
                w25_s = wavlm(torch.from_numpy(syn_16k).unsqueeze(0).to(device), e_mask, use_bf16=use_bf16)
                cos24 = float(F.cosine_similarity(w25_r[:, 24], w25_s[:, 24], dim=-1).mean().item())
                cos6 = float(
                    F.cosine_similarity(
                        normalize_wavlm_l6_target(w25_r),
                        normalize_wavlm_l6_target(w25_s),
                        dim=-1,
                    )
                    .mean()
                    .item()
                )

            _write_wav_atomic(job_dir / "ref_16k.wav", normalize_playback(wav_16k), SAMPLE_RATE_16K)
            if denoise:
                _write_wav_atomic(job_dir / "raw_16k.wav", normalize_playback(wav_raw_trim), SAMPLE_RATE_16K)
            _write_wav_atomic(job_dir / "m27_48k.wav", normalize_playback(wav48_f32), SAMPLE_RATE_48K)
            tmp_npz = job_dir / "controls_m27.tmp.npz"
            np.savez_compressed(
                tmp_npz,
                m27_50hz=m27_all_50.astype(np.float32),
                names=np.asarray(M27_NAMES),
            )
            os.replace(tmp_npz, job_dir / "controls_m27.npz")
            (job_dir / "tract_glottis_anim.json").unlink(missing_ok=True)

            run_neural = ckpt_choice in (
                "auto",
                "neural_synth",
                "neural_latest",
                "neural_best",
                "neural_v2_archive",
                "neural_v1_archive",
            ) or (speaker_ref_path is not None)

            neural_info: Dict[str, Any] = {}
            if run_neural:
                gen, neural_meta = self._get_neural_generator(device, ckpt_choice)
                spk_enc = self._get_speaker_encoder(device)

                spk_wav_raw = wav_16k
                spk_ref_label = ""
                if speaker_ref_path is not None and speaker_ref_path.is_file():
                    spk_wav_raw = load_audio_16k(speaker_ref_path, max_duration_sec=30.0)
                    _write_wav_atomic(job_dir / "ref_spk_16k.wav", normalize_playback(spk_wav_raw), SAMPLE_RATE_16K)
                    spk_ref_label = orig_spk_filename or speaker_ref_path.name
                max_spk_s = 10 * SAMPLE_RATE_16K
                if len(spk_wav_raw) > max_spk_s:
                    off_s = (len(spk_wav_raw) - max_spk_s) // 2
                    spk_wav_clip = np.ascontiguousarray(spk_wav_raw[off_s : off_s + max_spk_s], dtype=np.float32)
                else:
                    spk_wav_clip = np.ascontiguousarray(spk_wav_raw, dtype=np.float32)

                m27_norm_all = normalize_m27(m27_all_50.astype(np.float32))
                with torch.inference_mode():
                    e_spk = spk_enc(torch.from_numpy(spk_wav_clip).unsqueeze(0).to(device), allow_grad=False, use_bf16=use_bf16)
                    m27_t = torch.from_numpy(m27_norm_all).unsqueeze(0).to(device)
                    neural_16k = _synthesize_neural_chunked(gen, m27_t, e_spk, hop_samples=WAVLM_HOP_SAMPLES)

                    n_eval_arr = np.ascontiguousarray(neural_16k[:eval_s], dtype=np.float32)
                    if len(n_eval_arr) < eval_s:
                        n_eval_arr = np.pad(n_eval_arr, (0, eval_s - len(n_eval_arr)))
                    n_eval_t = torch.from_numpy(n_eval_arr).unsqueeze(0).to(device)
                    w25_n = wavlm(n_eval_t, e_mask, use_bf16=use_bf16)
                    n_cos24 = float(F.cosine_similarity(w25_r[:, 24], w25_n[:, 24], dim=-1).mean().item())
                    n_cos6 = float(
                        F.cosine_similarity(
                            normalize_wavlm_l6_target(w25_r),
                            normalize_wavlm_l6_target(w25_n),
                            dim=-1,
                        )
                        .mean()
                        .item()
                    )
                    e_hat_n = spk_enc(n_eval_t, allow_grad=False, use_bf16=use_bf16)
                    n_spk_cos = float(F.cosine_similarity(e_hat_n, e_spk, dim=-1).mean().item())

                _write_wav_atomic(job_dir / "neural_16k.wav", normalize_playback(neural_16k), SAMPLE_RATE_16K)
                disk_prefix = "/web_infer" if (job_dir.parent == self.config.run_root / "web_infer") else url_prefix.rstrip("/")
                suffix_audio = "" if disk_prefix == "/web_infer" else "/audio"
                neural_info = {
                    "synth_mode": "both",
                    "primary_syn": "neural",
                    "neural_checkpoint": dict(neural_meta),
                    "neural_cos24": round(n_cos24, 4),
                    "neural_cos6": round(n_cos6, 4),
                    "neural_spk_cos": round(n_spk_cos, 4),
                    "neural_url": f"{disk_prefix}/{job_id}{suffix_audio}/neural_16k.wav",
                    "neural_download_url": f"{disk_prefix}/{job_id}{suffix_audio}/neural_16k.wav?download=1",
                    "speaker_ref_name": spk_ref_label,
                }
                if spk_ref_label:
                    neural_info["speaker_ref_url"] = f"{disk_prefix}/{job_id}{suffix_audio}/ref_spk_16k.wav"

        disk_prefix = "/web_infer" if (job_dir.parent == self.config.run_root / "web_infer") else url_prefix.rstrip("/")
        suffix_audio = "" if disk_prefix == "/web_infer" else "/audio"
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        result: Dict[str, Any] = {
            "job_id": job_id,
            "status": "done",
            "filename": orig_filename,
            "created_at": created_at or now_str,
            "dur_sec": dur_sec,
            "num_chunks": len(chunks_plan),
            "checkpoint": {
                "stage": motor_stage,
                "step": motor_step,
                "file": motor_file,
                "device": str(device),
            },
            "cos24": round(cos24, 4),
            "cos6": round(cos6, 4),
            "glottis_summary": _glottis_summary(m27_all_50),
            "ref_url": f"{disk_prefix}/{job_id}{suffix_audio}/ref_16k.wav",
            "syn_url": f"{disk_prefix}/{job_id}{suffix_audio}/m27_48k.wav",
            "download_url": f"{disk_prefix}/{job_id}{suffix_audio}/m27_48k.wav?download=1",
            "wall_seconds": round(time.perf_counter() - t0, 2),
            "denoised": bool(denoise),
            **({"denoise_info": denoise_info, "raw_ref_url": f"{disk_prefix}/{job_id}{suffix_audio}/raw_16k.wav"} if denoise_info else {}),
            **({"resynthed_at": resynthed_at} if resynthed_at else {}),
            **neural_info,
        }
        _write_json_atomic(job_dir / "result.json", result)
        return rewrite_job_record_urls(result, job_dir=job_dir, url_prefix=url_prefix)

    def reconstruct_audio(
        self,
        audio_input: Union[str, Path, bytes, np.ndarray],
        *,
        filename: str = "upload.wav",
        checkpoint: str = "neural_best",
        device: str = "cpu",
        denoise: bool = False,
        denoise_preset: str = "standard",
        speaker_ref: Optional[Union[str, Path, bytes]] = None,
        speaker_ref_filename: str = "",
        job_id: Optional[str] = None,
        url_prefix: str = "/api/jobs",
    ) -> Dict[str, Any]:
        """Reconstruct 27-dim articulatory/glottal trajectory & synthesize audio for a single clip."""
        clean_name = Path(filename or "upload.wav").name
        ext = Path(clean_name).suffix.lower()
        if ext not in ALLOWED_EXTS:
            ext = ".wav"

        jid = job_id or f"{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}"
        if not SAFE_JOB_RE.match(jid):
            raise ValueError(f"无效的 job_id: {jid}")
        job_dir = (self.config.work_dir / jid).resolve()
        if job_dir.parent != self.config.work_dir.resolve():
            raise ValueError(f"非法工作目录路径: {job_dir}")
        job_dir.mkdir(parents=True, exist_ok=True)

        wav_raw_16k, raw_bytes = self._load_audio_any(audio_input, filename=clean_name)
        if raw_bytes is not None:
            (job_dir / f"input{ext}").write_bytes(raw_bytes)
        else:
            _write_wav_atomic(job_dir / "input.wav", wav_raw_16k, 16000)

        spk_path: Optional[Path] = None
        clean_spk_name = ""
        if speaker_ref is not None:
            if isinstance(speaker_ref, (bytes, bytearray)):
                if len(speaker_ref) > self.config.max_upload_bytes:
                    raise ValueError("说话人参考音频超过大小上限")
                clean_spk_name = Path(speaker_ref_filename or "spk_ref.wav").name
                spk_ext = Path(clean_spk_name).suffix.lower()
                if spk_ext not in ALLOWED_EXTS:
                    spk_ext = ".wav"
                spk_path = job_dir / f"spk_ref{spk_ext}"
                spk_path.write_bytes(bytes(speaker_ref))
            else:
                src_spk = Path(speaker_ref)
                if src_spk.is_file():
                    clean_spk_name = speaker_ref_filename or src_spk.name
                    spk_ext = src_spk.suffix.lower() if src_spk.suffix.lower() in ALLOWED_EXTS else ".wav"
                    spk_path = job_dir / f"spk_ref{spk_ext}"
                    if src_spk.resolve() != spk_path.resolve():
                        spk_path.write_bytes(src_spk.read_bytes())

        return self._run_pipeline_in_dir(
            job_dir,
            wav_raw_16k=wav_raw_16k,
            orig_filename=clean_name,
            checkpoint=checkpoint,
            device_pref=device,
            denoise=denoise,
            denoise_preset=denoise_preset,
            speaker_ref_path=spk_path,
            orig_spk_filename=clean_spk_name,
            url_prefix=url_prefix,
        )

    def resynthesize_job(
        self,
        job_id: str,
        *,
        checkpoint: str = "neural_best",
        device: str = "cpu",
        denoise: Optional[bool] = None,
        denoise_preset: Optional[str] = None,
        url_prefix: str = "/api/jobs",
    ) -> Dict[str, Any]:
        """Re-run M27 reconstruction & synthesis on an existing archived job."""
        if not SAFE_JOB_RE.match(job_id):
            raise ValueError(f"无效的 job_id: {job_id}")
        job_dir = (self.config.work_dir / job_id).resolve()
        if job_dir.parent != self.config.work_dir.resolve() or not job_dir.is_dir():
            raise FileNotFoundError(f"未找到历史任务目录: {job_id}")

        old_res: Dict[str, Any] = {}
        res_file = job_dir / "result.json"
        if res_file.is_file():
            old_res = json.loads(res_file.read_text(encoding="utf-8"))

        src_path = _find_input_file(job_dir, "input")
        if src_path is None:
            for cand_name in ("raw_16k.wav", "ref_16k.wav"):
                if (job_dir / cand_name).is_file():
                    src_path = job_dir / cand_name
                    break
        if src_path is None:
            raise FileNotFoundError(f"{job_id} 缺少原始输入音频")

        from tt3.inference import load_audio_16k

        wav_raw_16k = load_audio_16k(src_path, max_duration_sec=self.config.max_duration_sec)
        use_denoise = bool(old_res.get("denoised", False)) if denoise is None else bool(denoise)
        eff_preset = denoise_preset or str((old_res.get("denoise_info") or {}).get("preset") or "standard")
        spk_path = _find_input_file(job_dir, "spk_ref")
        orig_spk_name = str(old_res.get("speaker_ref_name") or (spk_path.name if spk_path else ""))

        return self._run_pipeline_in_dir(
            job_dir,
            wav_raw_16k=wav_raw_16k,
            orig_filename=str(old_res.get("filename") or src_path.name),
            checkpoint=checkpoint,
            device_pref=device,
            denoise=use_denoise,
            denoise_preset=eff_preset,
            speaker_ref_path=spk_path,
            orig_spk_filename=orig_spk_name,
            created_at=str(old_res.get("created_at") or datetime.now().strftime("%Y-%m-%d %H:%M:%S")),
            resynthed_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            url_prefix=url_prefix,
        )

    def resynthesize_all(
        self,
        *,
        checkpoint: str = "neural_best",
        device: str = "cpu",
        on_progress: Optional[Callable[[int, int, str], None]] = None,
        url_prefix: str = "/api/jobs",
    ) -> List[Dict[str, Any]]:
        """Batch resynthesize all jobs in work_dir sequentially."""
        jobs = self.list_jobs(limit=500, url_prefix=url_prefix)
        out: List[Dict[str, Any]] = []
        total = len(jobs)
        for i, item in enumerate(jobs):
            jid = str(item["job_id"])
            if on_progress is not None:
                on_progress(i + 1, total, str(item.get("filename") or jid))
            out.append(
                self.resynthesize_job(
                    jid,
                    checkpoint=checkpoint,
                    device=device,
                    url_prefix=url_prefix,
                )
            )
        return out

    # ------------------------------------------------------------------
    # Jobs & Animation Extraction
    # ------------------------------------------------------------------
    def list_jobs(self, limit: int = 100, url_prefix: str = "/api/jobs") -> List[Dict[str, Any]]:
        items: List[Dict[str, Any]] = []
        if not self.config.work_dir.is_dir():
            return items
        for res_file in sorted(self.config.work_dir.glob("*/result.json"), reverse=True):
            try:
                rec = json.loads(res_file.read_text(encoding="utf-8"))
                if isinstance(rec, dict) and rec.get("status") == "done":
                    items.append(rewrite_job_record_urls(rec, job_dir=res_file.parent, url_prefix=url_prefix))
                    if len(items) >= limit:
                        break
            except Exception:
                continue
        return items

    def get_job(self, job_id: str, url_prefix: str = "/api/jobs") -> Dict[str, Any]:
        if not SAFE_JOB_RE.match(job_id):
            raise ValueError(f"无效的 job_id: {job_id}")
        job_dir = (self.config.work_dir / job_id).resolve()
        res_file = job_dir / "result.json"
        if job_dir.parent != self.config.work_dir.resolve() or not res_file.is_file():
            raise FileNotFoundError(f"未找到任务记录: {job_id}")
        rec = json.loads(res_file.read_text(encoding="utf-8"))
        return rewrite_job_record_urls(rec, job_dir=job_dir, url_prefix=url_prefix)

    def get_job_controls(self, job_id: str) -> Dict[str, Any]:
        """Load 50 Hz 27-dim motor trajectory ``(T, 27)`` + channel names for downstream models."""
        if not SAFE_JOB_RE.match(job_id):
            raise ValueError(f"无效的 job_id: {job_id}")
        job_dir = (self.config.work_dir / job_id).resolve()
        npz_path = (job_dir / "controls_m27.npz").resolve()
        if job_dir.parent != self.config.work_dir.resolve() or not npz_path.is_file():
            raise FileNotFoundError(f"未找到轨迹文件: {job_id}/controls_m27.npz")
        with np.load(npz_path, allow_pickle=False) as d:
            m27 = np.asarray(d["m27_50hz"], dtype=np.float32)
            names = [str(x) for x in d["names"].tolist()] if "names" in d else []
        return {
            "job_id": job_id,
            "fps": 50,
            "frames": int(m27.shape[0]),
            "names": names,
            "m27_50hz": m27,
        }

    def _get_anim_engine(self):
        from tt3.tract_anim import open_jd2_engine

        if self._anim_engine is None:
            self._anim_engine = open_jd2_engine()
        return self._anim_engine

    def extract_animation(self, m27_50hz: np.ndarray, *, fps: int = 25) -> Dict[str, Any]:
        """Extract native JD2 sagittal vocal tract contours & glottis state at target FPS."""
        from tt3.tract_anim import extract_m27_animation

        with self._anim_lock:
            eng = self._get_anim_engine()
            return extract_m27_animation(eng, m27_50hz, fps=fps)

    def get_job_animation_bytes(self, job_id: str, *, fps: int = 25) -> bytes:
        """Return compact UTF-8 JSON bytes (`m27_anim_v3`) with LRU + disk cache."""
        if not SAFE_JOB_RE.match(job_id):
            raise ValueError(f"无效的 job_id: {job_id}")
        job_dir = (self.config.work_dir / job_id).resolve()
        npz_path = (job_dir / "controls_m27.npz").resolve()
        if job_dir.parent != self.config.work_dir.resolve() or not npz_path.is_file():
            raise FileNotFoundError(f"未找到轨迹文件: {job_id}")

        eff_fps = max(5, min(50, int(fps)))
        st = npz_path.stat()
        key = (str(npz_path), st.st_mtime_ns, eff_fps)

        with self._anim_lock:
            if key in self._anim_cache:
                self._anim_cache.move_to_end(key)
                return self._anim_cache[key]

            cache_file = job_dir / "tract_glottis_anim.json"
            if eff_fps == 25 and cache_file.is_file():
                try:
                    if cache_file.stat().st_mtime_ns >= st.st_mtime_ns:
                        raw_disk = cache_file.read_bytes()
                        if b'"schema":"m27_anim_v3"' in raw_disk[:160]:
                            self._anim_cache[key] = raw_disk
                            if len(self._anim_cache) > self._anim_cache_size:
                                self._anim_cache.popitem(last=False)
                            return raw_disk
                except OSError:
                    pass

            with np.load(npz_path, allow_pickle=False) as d:
                m27 = np.asarray(d["m27_50hz"], dtype=np.float32)

            from tt3.tract_anim import extract_m27_animation

            eng = self._get_anim_engine()
            payload = extract_m27_animation(eng, m27, fps=eff_fps)
            raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")

            if eff_fps == 25:
                tmp_file = job_dir / "tract_glottis_anim.tmp.json"
                try:
                    tmp_file.write_bytes(raw)
                    os.replace(tmp_file, cache_file)
                except OSError:
                    pass

            self._anim_cache[key] = raw
            if len(self._anim_cache) > self._anim_cache_size:
                self._anim_cache.popitem(last=False)
            return raw
