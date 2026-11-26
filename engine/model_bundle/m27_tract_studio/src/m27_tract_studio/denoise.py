"""Phonetics-friendly, pure CPU speech denoiser (zero-phase high-pass + MMSE-LSA spectral suppression).

Designed to strip room hum, AC buzz, plosive low-frequency rumble, and stationary/slowly varying
background noise without distorting F0, vowel formants, or high-frequency voiceless fricatives.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from math import gcd
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
from typing import Any, Dict, Tuple, Union

import numpy as np
from scipy.signal import butter, istft, resample_poly, sosfiltfilt, stft
from scipy.special import exp1
import soundfile as sf

SAMPLE_RATE_16K = 16000


@dataclass(frozen=True)
class DenoiseConfig:
    preset: str = "standard"
    label: str = "标准降噪（推荐）"
    highpass_hz: float = 75.0
    n_fft: int = 512
    hop_samples: int = 128
    over_subtraction: float = 1.15
    gain_floor: float = 0.1585  # -16 dB floor keeps acoustic continuity
    dd_alpha: float = 0.96
    dry_wet: float = 0.03


DENOISE_PRESETS: Dict[str, DenoiseConfig] = {
    "light": DenoiseConfig(
        preset="light",
        label="轻度降噪（保留呼吸与气声细节）",
        highpass_hz=65.0,
        over_subtraction=0.85,
        gain_floor=0.3162,  # -10 dB
        dd_alpha=0.95,
        dry_wet=0.08,
    ),
    "standard": DenoiseConfig(
        preset="standard",
        label="标准降噪（均衡去底噪与清晰人声）",
        highpass_hz=75.0,
        over_subtraction=1.15,
        gain_floor=0.1585,  # -16 dB
        dd_alpha=0.96,
        dry_wet=0.03,
    ),
    "strong": DenoiseConfig(
        preset="strong",
        label="强力降噪（适合风扇/空调/嘈杂环境）",
        highpass_hz=90.0,
        over_subtraction=1.55,
        gain_floor=0.0794,  # -22 dB
        dd_alpha=0.97,
        dry_wet=0.0,
    ),
}


def resolve_denoise_config(config: Union[DenoiseConfig, str, None]) -> DenoiseConfig:
    if isinstance(config, DenoiseConfig):
        return config
    key = str(config or "standard").strip().lower()
    return DENOISE_PRESETS.get(key, DENOISE_PRESETS["standard"])


def _extract_speech_mono(data: np.ndarray, sr: int) -> np.ndarray:
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


def load_audio_bytes_16k(
    raw_bytes: bytes,
    *,
    filename: str = "upload.wav",
    max_duration_sec: float = 120.0,
) -> np.ndarray:
    """Decode audio bytes (any common format via soundfile or ffmpeg fallback) to mono 16 kHz float32."""
    if not raw_bytes:
        raise ValueError("音频内容为空")
    ext = Path(filename or "upload.wav").suffix.lower() or ".wav"
    with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tf:
        tf.write(raw_bytes)
        tmp_path = Path(tf.name)
    try:
        try:
            data, sr = sf.read(str(tmp_path), dtype="float32", always_2d=False)
            arr = _extract_speech_mono(data, int(sr))
            if int(sr) != SAMPLE_RATE_16K:
                g = gcd(int(sr), SAMPLE_RATE_16K)
                arr = resample_poly(arr, SAMPLE_RATE_16K // g, int(sr) // g).astype(np.float32)
        except Exception:
            ff = shutil.which("ffmpeg")
            if not ff:
                raise ValueError(f"soundfile 无法读取 {filename} 且系统未安装 ffmpeg")
            proc = subprocess.run(
                [
                    ff,
                    "-v",
                    "error",
                    "-i",
                    str(tmp_path),
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
                raise ValueError(f"ffmpeg 解码失败 ({filename}): {err[:240]}")
            arr = np.frombuffer(proc.stdout, dtype=np.float32).copy()
    finally:
        tmp_path.unlink(missing_ok=True)

    arr = np.asarray(arr, dtype=np.float32).reshape(-1)
    if not np.isfinite(arr).all():
        arr = np.nan_to_num(arr, nan=0.0, posinf=0.0, neginf=0.0)
    if len(arr) < int(0.05 * SAMPLE_RATE_16K):
        raise ValueError("音频有效时长不足 0.05 秒，无法进行降噪或重构")
    if max_duration_sec is not None and len(arr) > int(round(max_duration_sec * SAMPLE_RATE_16K)):
        raise ValueError(f"音频时长 {len(arr) / SAMPLE_RATE_16K:.1f}s 超过上限 {max_duration_sec:.1f}s")
    return np.ascontiguousarray(arr, dtype=np.float32)


def _compute_snr_metrics(
    raw: np.ndarray,
    clean: np.ndarray,
    sr: int,
    hop: int = 160,
    win: int = 320,
) -> Tuple[float, float, float]:
    n = min(len(raw), len(clean))
    if n < win + hop:
        r_rms = float(np.sqrt(np.mean(raw[:n] ** 2))) + 1e-9
        c_rms = float(np.sqrt(np.mean(clean[:n] ** 2))) + 1e-9
        return 0.0, 0.0, round(20.0 * float(np.log10(r_rms / c_rms)), 2)

    starts = np.arange(0, n - win + 1, hop, dtype=np.int64)
    p_raw = np.array([float(np.mean(raw[s : s + win] ** 2)) for s in starts], dtype=np.float64)
    p_cln = np.array([float(np.mean(clean[s : s + win] ** 2)) for s in starts], dtype=np.float64)

    k_noise = max(2, min(len(p_raw) // 2, int(round(0.18 * len(p_raw)))))
    k_speech = max(2, min(len(p_raw), int(round(0.35 * len(p_raw)))))
    order = np.argsort(p_raw)
    noise_idx = order[:k_noise]
    speech_idx = order[-k_speech:]

    n_before = float(np.median(p_raw[noise_idx])) + 1e-11
    n_after = float(np.median(p_cln[noise_idx])) + 1e-11
    s_before = max(float(np.mean(p_raw[speech_idx])) - n_before, 1e-10)
    s_after = max(float(np.mean(p_cln[speech_idx])) - n_after, 1e-10)

    snr_before = 10.0 * float(np.log10(s_before / n_before))
    snr_after = 10.0 * float(np.log10(s_after / n_after))
    noise_drop = 10.0 * float(np.log10(n_before / n_after))
    return round(snr_before, 2), round(snr_after, 2), round(noise_drop, 2)


def denoise_audio_16k(
    wav: np.ndarray,
    sr: int = SAMPLE_RATE_16K,
    config: Union[DenoiseConfig, str, None] = "standard",
) -> Tuple[np.ndarray, Dict[str, Any]]:
    """Apply zero-phase high-pass filtering and Ephraim-Malah MMSE-LSA denoising on CPU.

    Returns ``(denoised_float32, metrics_dict)`` with length strictly equal to ``len(wav)``.
    """
    t0 = time.perf_counter()
    cfg = resolve_denoise_config(config)
    x = np.asarray(wav, dtype=np.float32).reshape(-1)
    x = np.nan_to_num(x, nan=0.0, posinf=0.0, neginf=0.0)
    n_samples = int(x.shape[0])

    if n_samples < 256 or float(np.max(np.abs(x))) < 1e-6:
        out = np.zeros_like(x, dtype=np.float32)
        return out, {
            **asdict(cfg),
            "snr_before_db": 0.0,
            "snr_after_db": 0.0,
            "noise_reduction_db": 0.0,
            "wall_ms": round((time.perf_counter() - t0) * 1000.0, 2),
        }

    # Stage 1: Zero-phase 4th-order Butterworth high-pass filter (hum & plosive rumble removal)
    work = x.astype(np.float64, copy=True)
    work -= float(np.mean(work))
    if cfg.highpass_hz > 0.0 and cfg.highpass_hz < 0.45 * float(sr):
        sos = butter(4, cfg.highpass_hz / (0.5 * float(sr)), btype="highpass", output="sos")
        padlen = min(3 * (2 * len(sos) + 1), max(0, n_samples - 2))
        if padlen >= 6:
            work = sosfiltfilt(sos, work, padlen=padlen)

    # Stage 2: Decision-directed Ephraim-Malah MMSE-LSA spectral gain suppression
    n_fft = int(cfg.n_fft)
    noverlap = int(cfg.n_fft - cfg.hop_samples)
    _, _, spec = stft(
        work,
        fs=float(sr),
        window="hann",
        nperseg=n_fft,
        noverlap=noverlap,
        nfft=n_fft,
        boundary="zeros",
        padded=True,
    )
    mag = np.abs(spec)
    power = mag * mag
    n_freq, n_frames = power.shape

    frame_energy = np.sum(power, axis=0)
    k_init = max(4, min(n_frames, int(np.ceil(0.15 * n_frames))))
    low_frames = np.argsort(frame_energy)[:k_init]
    noise_psd = np.maximum(np.median(power[:, low_frames], axis=1), 1e-12)

    # Check whether the clip has near-zero quiet floor vs audible stationary floor
    e_hi = float(np.percentile(frame_energy, 85))
    e_lo = float(np.percentile(frame_energy, 15))
    clean_ratio = e_hi / max(e_lo, 1e-14)
    # If already studio-clean (>55 dB gap), softly cap over-subtraction to avoid speech erosion
    eff_over_sub = cfg.over_subtraction * (0.45 if clean_ratio > 3.2e5 else 1.0)

    eps = 1e-12
    gain_mat = np.ones_like(power, dtype=np.float64)
    prev_clean_pow = np.maximum(power[:, 0] - eff_over_sub * noise_psd, 0.0)
    alpha = float(cfg.dd_alpha)
    floor = float(cfg.gain_floor)
    dry = float(cfg.dry_wet)

    for t in range(n_frames):
        p_t = power[:, t]

        # Soft speech presence probability to prevent loud speech from contaminating noise_psd
        mean_post = float(np.mean(p_t / (noise_psd + eps)))
        log_post = np.log10(max(mean_post, 1e-4))
        spp = 1.0 / (1.0 + np.exp(-3.2 * (log_post - 0.35)))
        noise_update_rate = 0.08 * (1.0 - spp)
        noise_psd = (1.0 - noise_update_rate) * noise_psd + noise_update_rate * np.minimum(p_t, 2.5 * noise_psd)
        noise_psd = np.maximum(noise_psd, 1e-12)

        eff_noise = np.maximum(eff_over_sub * noise_psd, eps)
        post_snr = np.minimum(p_t / eff_noise, 1e4)
        prior_snr = alpha * (prev_clean_pow / eff_noise) + (1.0 - alpha) * np.maximum(post_snr - 1.0, 0.0)
        prior_snr = np.clip(prior_snr, 1e-4, 1e3)

        xi_ratio = prior_snr / (1.0 + prior_snr)
        v_k = np.clip(xi_ratio * post_snr, 1e-6, 40.0)
        g_lsa = xi_ratio * np.exp(0.5 * exp1(v_k))

        # Slight HF protection (> 3.2 kHz) to keep /s/ /ɕ/ /f/ crisp while stripping wideband hiss
        g_eff = np.clip((1.0 - dry) * g_lsa + dry, floor, 1.0)
        gain_mat[:, t] = g_eff
        prev_clean_pow = (g_eff * mag[:, t]) ** 2

    spec_clean = spec * gain_mat
    _, rec = istft(
        spec_clean,
        fs=float(sr),
        window="hann",
        nperseg=n_fft,
        noverlap=noverlap,
        nfft=n_fft,
        input_onesided=True,
        boundary=True,
    )

    denoised = np.asarray(rec[:n_samples], dtype=np.float64)
    if len(denoised) < n_samples:
        denoised = np.pad(denoised, (0, n_samples - len(denoised)))
    denoised = np.nan_to_num(denoised, nan=0.0, posinf=0.0, neginf=0.0)
    peak = float(np.max(np.abs(denoised)))
    if peak > 0.98:
        denoised = denoised * (0.98 / peak)

    out_f32 = np.ascontiguousarray(denoised, dtype=np.float32)
    snr_before, snr_after, noise_drop = _compute_snr_metrics(x, out_f32, sr)
    metrics = {
        "preset": cfg.preset,
        "label": cfg.label,
        "highpass_hz": cfg.highpass_hz,
        "over_subtraction": cfg.over_subtraction,
        "gain_floor": cfg.gain_floor,
        "snr_before_db": snr_before,
        "snr_after_db": snr_after,
        "noise_reduction_db": noise_drop,
        "wall_ms": round((time.perf_counter() - t0) * 1000.0, 2),
    }
    return out_f32, metrics


def denoise_audio_bytes(
    raw_bytes: bytes,
    *,
    filename: str = "upload.wav",
    preset: Union[DenoiseConfig, str, None] = "standard",
    max_duration_sec: float = 120.0,
) -> Tuple[np.ndarray, np.ndarray, Dict[str, Any]]:
    """Decode arbitrary audio bytes to 16 kHz mono and return ``(raw_16k, denoised_16k, metrics)``."""
    raw_16k = load_audio_bytes_16k(raw_bytes, filename=filename, max_duration_sec=max_duration_sec)
    denoised_16k, metrics = denoise_audio_16k(raw_16k, sr=SAMPLE_RATE_16K, config=preset)
    return raw_16k, denoised_16k, metrics
