"""End-to-end TT3 inversion with silence-aware long-audio chunking, stitching, and JD2 tract export."""
from __future__ import annotations

import io
import json
from math import gcd
import os
from pathlib import Path
import shutil
import subprocess
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

import numpy as np
from scipy.signal import resample_poly
import soundfile as sf
import torch
import torch.nn.functional as F

from .constants import (
    HF_CACHE_DIR,
    M22_NAMES,
    SAMPLE_RATE_16K,
    SAMPLE_RATE_48K,
    WAVLM_HOP_SAMPLES,
    denormalize_m20,
    denormalize_pr,
)
from .models import FrozenWavLM, MotorEncoder, PressureEncoder
from .pitch import SwiftF0Extractor
from .playback import normalize_playback
from .tract_anim import PARTS_ORDER, extract_tract_animation
from .vtl_synth import R21Synthesizer

SAMPLES_PER_FRAME_48K = SAMPLE_RATE_48K // 50  # 960 samples (20 ms @ 48 kHz)


def extract_speech_mono(data: np.ndarray, sr: int) -> np.ndarray:
    """Convert mono or multi-channel audio to mono speech, automatically stripping an EGG channel if present."""
    arr = np.asarray(data, dtype=np.float32)
    if arr.ndim == 1:
        return arr
    if arr.shape[1] == 1:
        return arr[:, 0]
    if arr.shape[1] == 2:
        c0 = arr[:, 0]
        c1 = arr[:, 1]
        s0 = float(np.std(c0))
        s1 = float(np.std(c1))
        if s0 > 1e-7 and s1 > 1e-7:
            n = min(len(c0), 65536)
            corr = float(np.corrcoef(c0[:n], c1[:n])[0, 1])
            if corr < 0.85 and int(sr) >= 8000:
                freqs = np.fft.rfftfreq(n, 1.0 / float(sr))
                lo_m = (freqs >= 50.0) & (freqs < 500.0)
                hi_m = (freqs >= 1000.0) & (freqs < min(8000.0, 0.48 * float(sr)))
                if np.any(lo_m) and np.any(hi_m):
                    p0 = np.abs(np.fft.rfft(c0[:n])) ** 2
                    p1 = np.abs(np.fft.rfft(c1[:n])) ** 2
                    r0 = (float(np.sum(p0[hi_m])) + 1e-12) / (float(np.sum(p0[lo_m])) + 1e-12)
                    r1 = (float(np.sum(p1[hi_m])) + 1e-12) / (float(np.sum(p1[lo_m])) + 1e-12)
                    if r1 < 0.025 and r0 >= 5.0 * r1:
                        return c0
                    if r0 < 0.025 and r1 >= 5.0 * r0:
                        return c1
    return arr.mean(axis=1)


def load_audio_16k(path: Path, max_duration_sec: Optional[float] = None) -> np.ndarray:
    """Load any common audio/media file as mono float32 @ 16 kHz, falling back to ffmpeg."""
    audio_path = Path(path)
    if not audio_path.is_file():
        raise FileNotFoundError(f"输入音频不存在: {audio_path}")

    audio: Optional[np.ndarray] = None
    try:
        data, sr = sf.read(str(audio_path), dtype="float32", always_2d=False)
        arr = extract_speech_mono(data, int(sr))
        if int(sr) != SAMPLE_RATE_16K:
            g = gcd(int(sr), SAMPLE_RATE_16K)
            arr = resample_poly(arr, SAMPLE_RATE_16K // g, int(sr) // g).astype(np.float32)
        audio = arr
    except Exception:
        ff = shutil.which("ffmpeg")
        if not ff:
            raise ValueError(f"soundfile 无法读取 {audio_path.name} 且系统未找到 ffmpeg")
        proc = subprocess.run(
            [
                ff,
                "-v",
                "error",
                "-i",
                str(audio_path),
                "-ac",
                "1",
                "-ar",
                str(SAMPLE_RATE_16K),
                "-f",
                "f32le",
                "-",
            ],
            capture_output=True,
            timeout=120,
            check=False,
        )
        if proc.returncode != 0 or not proc.stdout:
            err = proc.stderr.decode("utf-8", errors="replace").strip()
            raise ValueError(f"ffmpeg 解码失败 ({audio_path.name}): {err[:240]}")
        audio = np.frombuffer(proc.stdout, dtype=np.float32).copy()

    audio = np.asarray(audio, dtype=np.float32).reshape(-1)
    if not np.isfinite(audio).all():
        audio = np.nan_to_num(audio, nan=0.0, posinf=0.0, neginf=0.0)

    if len(audio) < int(0.05 * SAMPLE_RATE_16K):
        raise ValueError("音频有效时长不足 0.05 秒，无法进行声道反演")
    if max_duration_sec is not None and len(audio) > int(round(max_duration_sec * SAMPLE_RATE_16K)):
        raise ValueError(
            f"音频时长 {len(audio) / SAMPLE_RATE_16K:.1f}s 超过上限 {max_duration_sec:.1f}s"
        )
    return audio


def _align_to_frame(sample_idx: int, hop_samples: int = WAVLM_HOP_SAMPLES) -> int:
    return int(round(sample_idx / hop_samples)) * hop_samples


def _pick_quietest_split(
    cs: np.ndarray,
    total_samples: int,
    lo_samp: int,
    hi_samp: int,
    hop_samples: int,
    sr: int,
) -> int:
    half_win = max(1, int(round(0.0125 * sr)))
    first = max(hop_samples, ((lo_samp + hop_samples - 1) // hop_samples) * hop_samples)
    last = min(total_samples - hop_samples, (hi_samp // hop_samples) * hop_samples)
    if last < first:
        aligned = _align_to_frame((lo_samp + hi_samp) // 2, hop_samples)
        return max(hop_samples, min(total_samples - hop_samples, aligned))

    cands = np.arange(first, last + 1, hop_samples, dtype=np.int64)
    w0 = np.maximum(0, cands - half_win)
    w1 = np.minimum(total_samples, cands + half_win)
    energy = (cs[w1] - cs[w0]) / np.maximum(1, w1 - w0)
    best_idx = int(np.argmin(energy))
    return int(cands[best_idx])


def plan_silence_chunks(
    wav_16k: np.ndarray,
    sr: int = SAMPLE_RATE_16K,
    max_chunk_sec: float = 10.0,
    min_chunk_sec: float = 3.0,
    target_chunk_sec: float = 8.0,
    min_silence_ms: float = 100.0,
) -> List[Dict[str, Any]]:
    """Split long audio into <= max_chunk_sec segments aligned on 50 Hz frame boundaries."""
    x = np.asarray(wav_16k, dtype=np.float64).reshape(-1)
    n = int(len(x))
    hop_align = max(1, int(round(sr * 0.02)))  # 320 samples @ 16 kHz (50 Hz grid)

    max_sec = max(2.0, float(max_chunk_sec))
    min_sec = min(max(0.5, float(min_chunk_sec)), max_sec * 0.65)
    target_sec = float(np.clip(target_chunk_sec, min_sec + 0.4, max(min_sec + 0.5, max_sec - 0.3)))

    max_samp = max(hop_align * 2, _align_to_frame(int(round(max_sec * sr)), hop_align))
    min_samp = max(hop_align, min(max_samp - hop_align, _align_to_frame(int(round(min_sec * sr)), hop_align)))

    if n <= max_samp:
        return [
            {
                "index": 0,
                "start_16k": 0,
                "end_16k": n,
                "start_sec": 0.0,
                "end_sec": round(n / sr, 3),
                "split_reason": "single",
            }
        ]

    win = max(1, int(round(0.025 * sr)))
    hop = max(1, int(round(0.010 * sr)))
    cs = np.concatenate([np.zeros(1, dtype=np.float64), np.cumsum(x * x)])

    if n >= win:
        starts = np.arange(0, n - win + 1, hop, dtype=np.int64)
        rms = np.sqrt(np.maximum(0.0, (cs[starts + win] - cs[starts]) / win))
    else:
        starts = np.zeros(1, dtype=np.int64)
        rms = np.array([float(np.sqrt(np.mean(x * x))) if n else 0.0], dtype=np.float64)

    rms_db = 20.0 * np.log10(rms + 1e-8)
    p10 = float(np.percentile(rms_db, 10))
    p85 = float(np.percentile(rms_db, 85))
    sil_thresh_db = float(np.clip(min(p85 - 18.0, max(p10 + 8.0, -42.0)), -55.0, -24.0))

    min_hops = max(1, int(round(float(min_silence_ms) / 10.0)))
    silent_mask = rms_db <= sil_thresh_db
    intervals: List[Tuple[int, int, float]] = []
    run_start: Optional[int] = None
    for i, flag in enumerate(silent_mask):
        if flag and run_start is None:
            run_start = i
        elif not flag and run_start is not None:
            if i - run_start >= min_hops:
                s0 = int(starts[run_start])
                s1 = int(starts[i - 1] + win)
                intervals.append((s0, s1, float(np.min(rms_db[run_start:i]))))
            run_start = None
    if run_start is not None and len(silent_mask) - run_start >= min_hops:
        s0 = int(starts[run_start])
        s1 = int(starts[len(silent_mask) - 1] + win)
        intervals.append((s0, s1, float(np.min(rms_db[run_start:]))))

    chunks: List[Dict[str, Any]] = []
    cursor = 0
    while cursor < n:
        rem = n - cursor
        if rem <= max_samp:
            chunks.append(
                {
                    "index": len(chunks),
                    "start_16k": cursor,
                    "end_16k": n,
                    "start_sec": round(cursor / sr, 3),
                    "end_sec": round(n / sr, 3),
                    "split_reason": "tail" if chunks else "single",
                }
            )
            break

        win_lo = min(n - hop_align, cursor + min_samp)
        win_hi = min(n - hop_align, cursor + max_samp)
        eff_target_sec = target_sec
        if (n - win_hi) < int(1.5 * sr) and rem <= int(1.5 * max_samp):
            tail_floor = min(win_hi, n - int(1.5 * sr))
            if tail_floor >= win_lo:
                win_hi = tail_floor
                eff_target_sec = max(min_sec, (rem * 0.5) / sr)

        best_score = -1e18
        best_iv: Optional[Tuple[int, int, float]] = None
        for iv_start, iv_end, min_db in intervals:
            mid = 0.5 * (iv_start + iv_end)
            if not (win_lo <= mid <= win_hi):
                continue
            dur_s = (iv_end - iv_start) / sr
            mid_rel_s = (mid - cursor) / sr
            score = dur_s * 1.5 + max(0.0, (sil_thresh_db - min_db) / 20.0) - 0.12 * abs(mid_rel_s - eff_target_sec)
            if score > best_score:
                best_score = score
                best_iv = (iv_start, iv_end, min_db)

        if best_iv is not None:
            cand_lo = max(win_lo, best_iv[0])
            cand_hi = min(win_hi, best_iv[1])
            if cand_hi < cand_lo:
                mid = _align_to_frame(int(round(0.5 * (best_iv[0] + best_iv[1]))), hop_align)
                split = max(win_lo, min(win_hi, mid))
            else:
                split = _pick_quietest_split(cs, n, cand_lo, cand_hi, hop_align, sr)
            reason = "silence"
        else:
            fallback_lo = max(win_lo, cursor + int(0.55 * max_samp))
            if fallback_lo > win_hi:
                fallback_lo = win_lo
            split = _pick_quietest_split(cs, n, fallback_lo, win_hi, hop_align, sr)
            reason = "low_energy"

        split = _align_to_frame(split, hop_align)
        split = max(cursor + hop_align, min(n - hop_align, split))
        if split <= cursor:
            split = min(n, cursor + max_samp)

        chunks.append(
            {
                "index": len(chunks),
                "start_16k": cursor,
                "end_16k": split,
                "start_sec": round(cursor / sr, 3),
                "end_sec": round(split / sr, 3),
                "split_reason": reason,
            }
        )
        cursor = split

    return chunks


def safe_torch_load(path: Path, map_location: str | torch.device = "cpu") -> Dict[str, Any]:
    """Read checkpoint bytes quickly into memory so concurrent training saves never lock the handle."""
    ckpt_path = Path(path)
    last_err: Optional[Exception] = None
    for attempt in range(3):
        try:
            raw = ckpt_path.read_bytes()
            return torch.load(io.BytesIO(raw), map_location=map_location, weights_only=False)
        except (PermissionError, OSError) as exc:
            last_err = exc
            if attempt < 2:
                time.sleep(0.3)
    raise RuntimeError(f"无法读取权重文件 {ckpt_path}: {last_err}")


def select_inference_device(device_pref: str = "auto") -> torch.device:
    pref = (device_pref or "auto").lower()
    if pref == "cpu":
        return torch.device("cpu")
    if not torch.cuda.is_available():
        return torch.device("cpu")
    if pref == "cuda":
        return torch.device("cuda")
    try:
        free_bytes, _ = torch.cuda.mem_get_info()
        if free_bytes >= 3 * (1024 ** 3):
            return torch.device("cuda")
    except Exception:
        return torch.device("cuda")
    return torch.device("cpu")


def _emit_progress(
    progress_cb: Optional[Callable[[Dict[str, Any]], None]],
    *,
    stage: str,
    pct: float,
    message: str,
    extra: Optional[Dict[str, Any]] = None,
) -> None:
    if progress_cb is None:
        return
    payload: Dict[str, Any] = {
        "stage": stage,
        "pct": round(float(max(0.0, min(100.0, pct))), 1),
        "message": message,
    }
    if extra:
        payload.update(extra)
    progress_cb(payload)


def _stabilize_m22_for_retry(m22: np.ndarray) -> np.ndarray:
    arr = np.array(m22, dtype=np.float64, copy=True)
    if arr.shape[0] >= 3:
        m20 = arr[:, :20].copy()
        arr[1:-1, :20] = 0.25 * m20[:-2] + 0.50 * m20[1:-1] + 0.25 * m20[2:]
    arr[:, 20] = np.minimum(arr[:, 20], 1200.0)
    return arr


def _raised_cosine_fade(n: int, *, fade_in: bool) -> np.ndarray:
    if n <= 0:
        return np.ones(0, dtype=np.float32)
    u = (np.arange(n, dtype=np.float64) + 0.5) / n
    w = 0.5 * (1.0 - np.cos(np.pi * u)) if fade_in else 0.5 * (1.0 + np.cos(np.pi * u))
    return w.astype(np.float32)


def run_vtl_inference(
    *,
    input_path: Path,
    out_wav: Path,
    pr_ckpt: Path,
    motor_ckpt: Path,
    out_controls: Optional[Path] = None,
    out_tract: Optional[Path] = None,
    out_input_16k: Optional[Path] = None,
    mode: str = "T24",
    device_pref: str = "auto",
    use_bf16: bool = True,
    raw_level: bool = False,
    max_chunk_sec: float = 10.0,
    min_chunk_sec: float = 3.0,
    target_chunk_sec: float = 8.0,
    tract_fps: int = 25,
    max_duration_sec: Optional[float] = None,
    progress_cb: Optional[Callable[[Dict[str, Any]], None]] = None,
) -> Dict[str, Any]:
    """Run end-to-end TT3 inversion and R21 resynthesis with silence-aware chunking."""
    t_start = time.perf_counter()
    _emit_progress(progress_cb, stage="load_audio", pct=2.0, message="正在读取并重采样音频到 16 kHz...")
    wav_16k = load_audio_16k(Path(input_path), max_duration_sec=max_duration_sec)
    orig_samples_16k = len(wav_16k)

    if out_input_16k is not None:
        p_in = Path(out_input_16k)
        p_in.parent.mkdir(parents=True, exist_ok=True)
        in_norm = normalize_playback(wav_16k, target_rms=0.12, max_peak=0.92)
        sf.write(str(p_in), in_norm, SAMPLE_RATE_16K, subtype="PCM_16")

    chunks = plan_silence_chunks(
        wav_16k,
        sr=SAMPLE_RATE_16K,
        max_chunk_sec=max_chunk_sec,
        min_chunk_sec=min_chunk_sec,
        target_chunk_sec=target_chunk_sec,
    )
    total_frames = max(1, int(np.ceil(orig_samples_16k / WAVLM_HOP_SAMPLES)))
    padded_len_16k = total_frames * WAVLM_HOP_SAMPLES
    padded_full_16k = np.zeros(padded_len_16k, dtype=np.float32)
    padded_full_16k[:orig_samples_16k] = wav_16k

    for i, ch in enumerate(chunks):
        sf0 = ch["start_16k"] // WAVLM_HOP_SAMPLES
        ef0 = min(total_frames, int(np.ceil(ch["end_16k"] / WAVLM_HOP_SAMPLES)))
        if i == len(chunks) - 1:
            ef0 = total_frames
        ch["start_frame"] = int(sf0)
        ch["end_frame"] = int(ef0)
        ch["frames"] = int(ef0 - sf0)

    device = select_inference_device(device_pref)
    eff_bf16 = bool(use_bf16 and device.type == "cuda")
    _emit_progress(
        progress_cb,
        stage="load_models",
        pct=6.0,
        message=f"正在加载 WavLM / PR / Motor 模型 ({device.type.upper()}) · 共 {len(chunks)} 段...",
        extra={"num_chunks": len(chunks), "device": device.type},
    )

    wavlm = FrozenWavLM(cache_dir=HF_CACHE_DIR).to(device)
    pr_encoder = PressureEncoder().to(device)
    pr_ckpt_data = safe_torch_load(Path(pr_ckpt), map_location="cpu")
    pr_encoder.load_state_dict(pr_ckpt_data["model"])
    pr_encoder.eval()

    motor_ckpt_data = safe_torch_load(Path(motor_ckpt), map_location="cpu")
    eff_mode = motor_ckpt_data.get("extra", {}).get("mode", mode)
    motor_encoder = MotorEncoder(mode=eff_mode).to(device)
    motor_encoder.load_state_dict(motor_ckpt_data["model"])
    motor_encoder.eval()
    f0_ext = SwiftF0Extractor()

    pad_frames = 15  # 300 ms neural context on each side
    m22_parts: List[np.ndarray] = []
    f0_parts: List[np.ndarray] = []
    voiced_parts: List[np.ndarray] = []
    w24_ref_chunks: List[torch.Tensor] = []

    n_chunks = len(chunks)
    for ci, ch in enumerate(chunks):
        sf0, ef0 = ch["start_frame"], ch["end_frame"]
        ctx_s = max(0, sf0 - pad_frames)
        ctx_e = min(total_frames, ef0 + pad_frames)
        ctx_wav = padded_full_16k[ctx_s * WAVLM_HOP_SAMPLES : ctx_e * WAVLM_HOP_SAMPLES]
        ctx_frames = ctx_e - ctx_s

        f0_ctx, voiced_ctx = f0_ext.extract_50hz(ctx_wav, num_frames=ctx_frames)
        wav_t = torch.from_numpy(ctx_wav).unsqueeze(0).to(device)
        mask_t = torch.ones((1, ctx_frames), dtype=torch.float32, device=device)
        with torch.inference_mode():
            w25 = wavlm(wav_t, mask_t, use_bf16=eff_bf16)
            pr_norm = pr_encoder(w25, mask_t)[0, :, 0].cpu().numpy()
            m20_norm = motor_encoder(w25, mask_t)[0].cpu().numpy()

            sl0 = sf0 - ctx_s
            sl1 = ef0 - ctx_s
            w24_ref_chunks.append(w25[:, 24, sl0:sl1, :].detach().cpu())

        m20_phys = denormalize_m20(m20_norm[sl0:sl1])
        pr_phys = denormalize_pr(pr_norm[sl0:sl1])[:, None]
        f0_chunk = f0_ctx[sl0:sl1]
        voiced_chunk = voiced_ctx[sl0:sl1]

        m22_chunk = np.concatenate([m20_phys, pr_phys, f0_chunk[:, None]], axis=1).astype(np.float32)
        m22_parts.append(m22_chunk)
        f0_parts.append(f0_chunk.astype(np.float32))
        voiced_parts.append(voiced_chunk.astype(bool))

        pct = 10.0 + 40.0 * ((ci + 1) / n_chunks)
        _emit_progress(
            progress_cb,
            stage="neural_inversion",
            pct=pct,
            message=f"已完成神经反演第 {ci + 1}/{n_chunks} 段 ({ch['start_sec']:.2f}–{ch['end_sec']:.2f}s)",
            extra={"chunk_index": ci, "num_chunks": n_chunks},
        )

    m22_50hz = np.concatenate(m22_parts, axis=0)
    f0_hz = np.concatenate(f0_parts, axis=0)
    voiced_mask = np.concatenate(voiced_parts, axis=0)

    total_48k_padded = total_frames * SAMPLES_PER_FRAME_48K
    stitched_48k = np.zeros(total_48k_padded, dtype=np.float32)
    weight_48k = np.zeros(total_48k_padded, dtype=np.float32)

    r21_pad_frames = 5  # 100 ms VTL context
    half_xfade = 720    # 15 ms half -> 30 ms raised-cosine crossfade across interior seams
    warnings: List[str] = []
    l24_cos_num = 0.0
    l24_mse_num = 0.0
    l24_frame_den = 0

    with R21Synthesizer(section_count=65) as synth:
        for ci, ch in enumerate(chunks):
            sf0, ef0 = ch["start_frame"], ch["end_frame"]
            syn_s = max(0, sf0 - r21_pad_frames)
            syn_e = min(total_frames, ef0 + r21_pad_frames)
            sub_m22 = m22_50hz[syn_s:syn_e]

            res = synth.synthesize_50hz(sub_m22, return_48k=True)
            if res is None:
                res = synth.synthesize_50hz(_stabilize_m22_for_retry(sub_m22), return_48k=True)
                if res is not None:
                    warnings.append(f"第 {ci + 1} 段经轻量平滑+PR限幅重试后合成成功")

            if res is None:
                warnings.append(f"第 {ci + 1} 段 ({ch['start_sec']:.2f}–{ch['end_sec']:.2f}s) R21 合成失败，已置零填充")
                n_syn_frames = syn_e - syn_s
                syn_48k = np.zeros(n_syn_frames * SAMPLES_PER_FRAME_48K, dtype=np.float32)
                syn_16k = np.zeros(n_syn_frames * WAVLM_HOP_SAMPLES, dtype=np.float32)
            else:
                syn_48k, syn_16k = res

            has_left = sf0 > 0
            has_right = ef0 < total_frames
            g_start = max(0, sf0 * SAMPLES_PER_FRAME_48K - (half_xfade if has_left else 0))
            g_end = min(total_48k_padded, ef0 * SAMPLES_PER_FRAME_48K + (half_xfade if has_right else 0))

            syn_base_48k = syn_s * SAMPLES_PER_FRAME_48K
            l_start = max(0, g_start - syn_base_48k)
            l_end = min(len(syn_48k), g_end - syn_base_48k)
            seg = syn_48k[l_start:l_end]
            g_end_eff = g_start + len(seg)

            seg_w = np.ones(len(seg), dtype=np.float32)
            if has_left:
                ov_l = min(2 * half_xfade, len(seg_w))
                seg_w[:ov_l] *= _raised_cosine_fade(ov_l, fade_in=True)
            if has_right:
                ov_r = min(2 * half_xfade, len(seg_w))
                seg_w[-ov_r:] *= _raised_cosine_fade(ov_r, fade_in=False)

            stitched_48k[g_start:g_end_eff] += seg * seg_w
            weight_48k[g_start:g_end_eff] += seg_w

            # Acoustic WavLM L24 similarity on the core unpadded chunk
            u0 = (sf0 - syn_s) * WAVLM_HOP_SAMPLES
            u1 = (ef0 - syn_s) * WAVLM_HOP_SAMPLES
            n_ch_frames = ef0 - sf0
            syn_pad = np.zeros(n_ch_frames * WAVLM_HOP_SAMPLES, dtype=np.float32)
            core_16k = syn_16k[u0:u1]
            copy_len = min(len(core_16k), len(syn_pad))
            syn_pad[:copy_len] = core_16k[:copy_len]
            m_ch = torch.ones((1, n_ch_frames), dtype=torch.float32, device=device)
            with torch.inference_mode():
                w24_syn = wavlm(torch.from_numpy(syn_pad).unsqueeze(0).to(device), m_ch, use_bf16=eff_bf16)[:, 24, :, :]
                w24_ref = w24_ref_chunks[ci].to(device)
                mse_val = float(F.mse_loss(w24_syn, w24_ref).item())
                cos_val = float(F.cosine_similarity(w24_syn, w24_ref, dim=-1).mean().item())
            l24_cos_num += cos_val * n_ch_frames
            l24_mse_num += mse_val * n_ch_frames
            l24_frame_den += n_ch_frames

            pct = 52.0 + 38.0 * ((ci + 1) / n_chunks)
            _emit_progress(
                progress_cb,
                stage="vtl_synth",
                pct=pct,
                message=f"已完成 R21 声道重合成第 {ci + 1}/{n_chunks} 段 (Cos {cos_val:.4f})",
                extra={"chunk_index": ci, "num_chunks": n_chunks},
            )

        wav_48k = stitched_48k / np.maximum(weight_48k, 1e-6)
        expected_48k = int(round(orig_samples_16k * (SAMPLE_RATE_48K / SAMPLE_RATE_16K)))
        wav_48k = wav_48k[:expected_48k]
        peak_raw = float(np.max(np.abs(wav_48k))) if len(wav_48k) else 0.0
        wav_48k_out = wav_48k if raw_level else normalize_playback(wav_48k, target_rms=0.12, max_peak=0.92)

        out_wav_p = Path(out_wav)
        out_wav_p.parent.mkdir(parents=True, exist_ok=True)
        tmp_wav = out_wav_p.with_name(out_wav_p.stem + ".tmp.wav")
        sf.write(str(tmp_wav), wav_48k_out, SAMPLE_RATE_48K, format="WAV", subtype="PCM_16")
        os.replace(tmp_wav, out_wav_p)

        if out_controls is not None:
            ctrl_p = Path(out_controls)
            ctrl_p.parent.mkdir(parents=True, exist_ok=True)
            tmp_ctrl = ctrl_p.with_name(ctrl_p.stem + ".tmp.npz")
            np.savez_compressed(
                tmp_ctrl,
                names=np.asarray(M22_NAMES),
                m22_50hz=m22_50hz.astype(np.float32),
                f0_hz=f0_hz.astype(np.float32),
                voiced_mask=voiced_mask.astype(bool),
                chunks_json=np.asarray(json.dumps(chunks, ensure_ascii=False)),
            )
            os.replace(tmp_ctrl, ctrl_p)

        if out_tract is not None:
            _emit_progress(progress_cb, stage="tract_anim", pct=94.0, message="正在提取 JD2 声道矢状面动态轮廓...")
            tract_payload = extract_tract_animation(synth, m22_50hz, voiced_mask=voiced_mask, fps=tract_fps)
            tract_p = Path(out_tract)
            tract_p.parent.mkdir(parents=True, exist_ok=True)
            tmp_tract = tract_p.with_name(tract_p.stem + ".tmp.json")
            tmp_tract.write_text(json.dumps(tract_payload, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
            os.replace(tmp_tract, tract_p)

    l24_cos = round(l24_cos_num / max(1, l24_frame_den), 4)
    l24_mse = round(l24_mse_num / max(1, l24_frame_den), 5)
    elapsed_sec = round(time.perf_counter() - t_start, 2)

    result = {
        "input": str(input_path),
        "out_wav": str(out_wav),
        "out_controls": str(out_controls) if out_controls is not None else None,
        "out_tract": str(out_tract) if out_tract is not None else None,
        "mode": str(eff_mode),
        "device": device.type,
        "frames_50hz": int(total_frames),
        "samples_48k": int(len(wav_48k_out)),
        "duration_sec": round(len(wav_48k_out) / SAMPLE_RATE_48K, 3),
        "peak_before_norm": round(peak_raw, 5),
        "finite": bool(np.isfinite(wav_48k_out).all()),
        "chunks": chunks,
        "num_chunks": len(chunks),
        "wavlm_l24_cos": l24_cos,
        "wavlm_l24_mse": l24_mse,
        "warnings": warnings,
        "elapsed_sec": elapsed_sec,
    }
    _emit_progress(
        progress_cb,
        stage="done",
        pct=100.0,
        message=f"转换完成（共 {len(chunks)} 段 · Cos {l24_cos:.4f} · 耗时 {elapsed_sec:.1f}s）",
        extra={"num_chunks": len(chunks)},
    )
    return result
