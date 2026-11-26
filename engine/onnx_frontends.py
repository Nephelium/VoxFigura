"""Pure-NumPy / SciPy acoustic frontends and audio helpers for zero-PyTorch ONNX inference.

Matches the PyTorch frontends in `tt3.distill_models`, `tt3.m27_models`, `tt3.browser_m27_models`,
and `tt3.inference` without importing `torch`.
"""
from __future__ import annotations

from math import gcd
from pathlib import Path
import shutil
import subprocess
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from scipy.signal import resample_poly
import soundfile as sf

SAMPLE_RATE_16K = 16000
SAMPLE_RATE_48K = 48000
HOP_SAMPLES_16K = 320  # 50 Hz @ 16 kHz

# Cached filterbanks & windows keyed by (sr, n_fft, win_length, n_mels, f_min, f_max)
_MEL_FB_CACHE: Dict[Tuple[int, int, int, float, float], np.ndarray] = {}
_HANN_CENTERED_CACHE: Dict[Tuple[int, int], np.ndarray] = {}
_FREQ_MASK_CACHE: Dict[Tuple[int, int], Tuple[np.ndarray, np.ndarray]] = {}


def _hz_to_mel_slaney(hz: np.ndarray) -> np.ndarray:
    f_min = 0.0
    f_sp = 200.0 / 3.0
    min_log_hz = 1000.0
    min_log_mel = (min_log_hz - f_min) / f_sp
    logstep = np.log(6.4) / 27.0
    arr = np.asarray(hz, dtype=np.float64)
    mels = (arr - f_min) / f_sp
    log_mask = arr >= min_log_hz
    mels[log_mask] = min_log_mel + np.log(arr[log_mask] / min_log_hz) / logstep
    return mels


def _mel_to_hz_slaney(mels: np.ndarray) -> np.ndarray:
    f_min = 0.0
    f_sp = 200.0 / 3.0
    min_log_hz = 1000.0
    min_log_mel = (min_log_hz - f_min) / f_sp
    logstep = np.log(6.4) / 27.0
    arr = np.asarray(mels, dtype=np.float64)
    hz = f_min + f_sp * arr
    log_mask = arr >= min_log_mel
    hz[log_mask] = min_log_hz * np.exp(logstep * (arr[log_mask] - min_log_mel))
    return hz


def build_mel_filterbank(
    sr: int = SAMPLE_RATE_16K,
    n_fft: int = 1024,
    n_mels: int = 80,
    f_min: float = 40.0,
    f_max: float = 7600.0,
) -> np.ndarray:
    """Slaney-normalized Mel filterbank of shape `(n_mels, n_fft // 2 + 1)` float32."""
    key = (int(sr), int(n_fft), int(n_mels), float(f_min), float(f_max))
    cached = _MEL_FB_CACHE.get(key)
    if cached is not None:
        return cached
    n_freqs = n_fft // 2 + 1
    fft_freqs = np.linspace(0.0, sr / 2.0, n_freqs, dtype=np.float64)
    mel_edges = np.linspace(
        _hz_to_mel_slaney(np.array([f_min]))[0],
        _hz_to_mel_slaney(np.array([f_max]))[0],
        n_mels + 2,
        dtype=np.float64,
    )
    hz_edges = _mel_to_hz_slaney(mel_edges)
    fb = np.zeros((n_mels, n_freqs), dtype=np.float64)
    for i in range(n_mels):
        left, center, right = hz_edges[i], hz_edges[i + 1], hz_edges[i + 2]
        lower = (fft_freqs - left) / max(1e-8, center - left)
        upper = (right - fft_freqs) / max(1e-8, right - center)
        fb[i] = np.maximum(0.0, np.minimum(lower, upper))
        fb[i] *= 2.0 / max(1e-8, right - left)
    out = fb.astype(np.float32)
    _MEL_FB_CACHE[key] = out
    return out


def _centered_periodic_hann(n_fft: int, win_length: int) -> np.ndarray:
    """Centered periodic Hann window matching `torch.stft(..., window=torch.hann_window(win_length))`."""
    key = (int(n_fft), int(win_length))
    cached = _HANN_CENTERED_CACHE.get(key)
    if cached is not None:
        return cached
    k = np.arange(win_length, dtype=np.float64)
    win = (0.5 - 0.5 * np.cos(2.0 * np.pi * k / float(win_length))).astype(np.float32)
    buf = np.zeros(n_fft, dtype=np.float32)
    left = (n_fft - win_length) // 2
    buf[left : left + win_length] = win
    _HANN_CENTERED_CACHE[key] = buf
    return buf


def _band_masks(sr: int = SAMPLE_RATE_16K, n_fft: int = 1024) -> Tuple[np.ndarray, np.ndarray]:
    key = (int(sr), int(n_fft))
    cached = _FREQ_MASK_CACHE.get(key)
    if cached is not None:
        return cached
    freqs = np.linspace(0.0, sr / 2.0, n_fft // 2 + 1, dtype=np.float32)
    lf = ((freqs >= 60.0) & (freqs <= 1000.0)).astype(np.float32)
    hf = ((freqs >= 2000.0) & (freqs <= 7600.0)).astype(np.float32)
    _FREQ_MASK_CACHE[key] = (lf, hf)
    return lf, hf


def normalize_waveform_for_wavlm(wav: np.ndarray) -> np.ndarray:
    """Zero-mean unit-variance waveform normalization matching `tt3.models.normalize_waveform_for_wavlm`."""
    x = np.asarray(wav, dtype=np.float32)
    mean = x.mean(axis=-1, keepdims=True)
    diff = x - mean
    var = (diff * diff).mean(axis=-1, keepdims=True)
    std = np.sqrt(var + np.float32(1e-7))
    scale = np.where(std > np.float32(1e-4), std, np.float32(1.0))
    return (diff / scale).astype(np.float32)


def _pad_1d_reflect_or_zero(x: np.ndarray, pad_left: int, pad_right: int) -> np.ndarray:
    """Exact equivalent of PyTorch `F.pad(x, (pad_left, pad_right), mode='reflect' if L > max(...) else 'constant')`."""
    n_samples = x.shape[-1]
    mode = "reflect" if n_samples > max(pad_left, pad_right) else "constant"
    pad_width = [(0, 0)] * (x.ndim - 1) + [(pad_left, pad_right)]
    return np.pad(x, pad_width, mode=mode)


def compute_stft_power_50hz(
    wav_16k: np.ndarray,
    *,
    n_fft: int = 1024,
    win_length: int = 640,
    hop_length: int = HOP_SAMPLES_16K,
) -> np.ndarray:
    """Compute `(B, n_fft // 2 + 1, T)` float32 STFT power spectrum aligned to 50 Hz frames."""
    arr = np.asarray(wav_16k, dtype=np.float32)
    if arr.ndim == 1:
        arr = arr[None, :]
    bsz, n_samples = arr.shape
    target_frames = max(1, n_samples // hop_length)
    normed = normalize_waveform_for_wavlm(arr)

    pad_left = (n_fft - hop_length) // 2
    pad_right = n_fft - hop_length - pad_left
    padded = _pad_1d_reflect_or_zero(normed, pad_left, pad_right)

    window = _centered_periodic_hann(n_fft, win_length)
    n_padded = padded.shape[-1]
    if n_padded < n_fft:
        padded = np.pad(padded, ((0, 0), (0, n_fft - n_padded)), mode="constant")
        n_padded = n_fft
    n_frames_raw = 1 + (n_padded - n_fft) // hop_length
    # Stride view: (B, n_frames_raw, n_fft)
    s0, s1 = padded.strides
    frames = np.lib.stride_tricks.as_strided(
        padded,
        shape=(bsz, n_frames_raw, n_fft),
        strides=(s0, s1 * hop_length, s1),
    )
    windowed = frames * window[None, None, :]
    spec = np.fft.rfft(windowed, n=n_fft, axis=-1)
    power = (spec.real * spec.real + spec.imag * spec.imag).astype(np.float32)
    # (B, T_raw, F) -> (B, F, T_raw)
    power = np.transpose(power, (0, 2, 1))
    if power.shape[-1] > target_frames:
        power = power[..., :target_frames]
    elif power.shape[-1] < target_frames:
        power = np.pad(power, ((0, 0), (0, 0), (0, target_frames - power.shape[-1])), mode="constant")
    return np.ascontiguousarray(power, dtype=np.float32)


def extract_pure_logmel_50hz(
    wav_16k: np.ndarray,
    *,
    power: Optional[np.ndarray] = None,
    sr: int = SAMPLE_RATE_16K,
    n_fft: int = 1024,
    win_length: int = 640,
    hop_length: int = HOP_SAMPLES_16K,
    n_mels: int = 80,
    use_energy_feats: bool = True,
) -> np.ndarray:
    """Pure-NumPy equivalent of `PureLogMel50Hz` returning `(B, T, 163)` float32."""
    if power is None:
        power = compute_stft_power_50hz(wav_16k, n_fft=n_fft, win_length=win_length, hop_length=hop_length)
    fb = build_mel_filterbank(sr=sr, n_fft=n_fft, n_mels=n_mels, f_min=40.0, f_max=7600.0)
    mel = np.matmul(fb[None, :, :], power)  # (B, n_mels, T)
    log_mel = np.log(np.maximum(mel, np.float32(1e-6)))
    x = np.transpose(log_mel, (0, 2, 1))  # (B, T, n_mels)

    mean = x.mean(axis=1, keepdims=True)
    diff = x - mean
    std = np.sqrt((diff * diff).mean(axis=1, keepdims=True) + np.float32(1e-5))
    x = (diff / std).astype(np.float32)

    x_pad = np.pad(x, ((0, 0), (1, 1), (0, 0)), mode="edge")
    delta = (0.5 * (x_pad[:, 2:, :] - x_pad[:, :-2, :])).astype(np.float32)
    if not use_energy_feats:
        return np.ascontiguousarray(np.concatenate([x, delta], axis=-1), dtype=np.float32)

    target_frames = power.shape[-1]
    frame_energy = power.mean(axis=1)  # (B, T)
    frame_db = (10.0 * np.log10(np.maximum(frame_energy, np.float32(1e-10)))).astype(np.float32)
    k_idx = max(1, int(round(0.95 * target_frames)))
    sorted_db = np.sort(frame_db, axis=1)
    peak_db = sorted_db[:, k_idx - 1 : k_idx]
    rel_db = np.clip(frame_db - peak_db, -60.0, 0.0)
    rel_db_norm = (rel_db / 30.0 + 1.0).astype(np.float32)

    e_pad = np.pad(rel_db_norm, ((0, 0), (1, 1)), mode="edge")
    delta_e = np.clip(0.5 * (e_pad[:, 2:] - e_pad[:, :-2]), -1.0, 1.0).astype(np.float32)

    lf_mask, hf_mask = _band_masks(sr, n_fft)
    lf_e = (power * lf_mask[None, :, None]).sum(axis=1) / max(1.0, float(lf_mask.sum()))
    hf_e = (power * hf_mask[None, :, None]).sum(axis=1) / max(1.0, float(hf_mask.sum()))
    hf_lf = np.clip(10.0 * np.log10((hf_e + 1e-10) / (lf_e + 1e-10)) / 30.0, -1.0, 1.0).astype(np.float32)

    energy_feats = np.stack([rel_db_norm, delta_e, hf_lf], axis=-1)
    return np.ascontiguousarray(np.concatenate([x, delta, energy_feats], axis=-1), dtype=np.float32)


def extract_vq_cues_50hz(
    wav_16k: np.ndarray,
    *,
    power: Optional[np.ndarray] = None,
    sr: int = SAMPLE_RATE_16K,
    n_fft: int = 1024,
    win_length: int = 640,
    hop_length: int = HOP_SAMPLES_16K,
) -> np.ndarray:
    """Pure-NumPy equivalent of `VoiceQualityFrontend50Hz` returning `(B, T, 3)` float32."""
    if power is None:
        power = compute_stft_power_50hz(wav_16k, n_fft=n_fft, win_length=win_length, hop_length=hop_length)
    frame_energy = power.mean(axis=1)  # (B, T)
    log_rms = (0.5 * np.log(np.maximum(frame_energy, np.float32(1e-8)))).astype(np.float32)
    ref = np.quantile(log_rms, 0.95, axis=1, keepdims=True).astype(np.float32)
    rel_rms = np.clip((log_rms - ref) / 3.0, -2.5, 1.0).astype(np.float32)

    lf_mask, hf_mask = _band_masks(sr, n_fft)
    lf = (power * lf_mask[None, :, None]).sum(axis=1) / max(1.0, float(lf_mask.sum()))
    hf = (power * hf_mask[None, :, None]).sum(axis=1) / max(1.0, float(hf_mask.sum()))
    tilt = np.clip((np.log(np.maximum(hf, 1e-8)) - np.log(np.maximum(lf, 1e-8))) / 4.0, -2.5, 2.5).astype(np.float32)

    lr_pad = np.pad(log_rms, ((0, 0), (1, 1)), mode="edge")
    flux = np.clip(np.abs(0.5 * (lr_pad[:, 2:] - lr_pad[:, :-2])), 0.0, 3.0).astype(np.float32)
    return np.ascontiguousarray(np.stack([rel_rms, tilt, flux], axis=-1), dtype=np.float32)


def extract_cmn_logmel_spk(
    wav_16k: np.ndarray,
    *,
    power: Optional[np.ndarray] = None,
    sr: int = SAMPLE_RATE_16K,
    n_fft: int = 1024,
    win_length: int = 640,
    hop_length: int = HOP_SAMPLES_16K,
    n_mels: int = 80,
) -> np.ndarray:
    """Pure-NumPy equivalent of `BrowserLightSpeakerEncoder._extract_cmn_logmel` returning `(B, 80, T)` float32."""
    if power is None:
        power = compute_stft_power_50hz(wav_16k, n_fft=n_fft, win_length=win_length, hop_length=hop_length)
    fb = build_mel_filterbank(sr=sr, n_fft=n_fft, n_mels=n_mels, f_min=40.0, f_max=7600.0)
    mel = np.matmul(fb[None, :, :], power)
    log_mel = np.log(np.maximum(mel, np.float32(1e-6))).astype(np.float32)
    log_mel = log_mel - log_mel.mean(axis=-1, keepdims=True)
    return np.ascontiguousarray(log_mel, dtype=np.float32)


def make_vocoder_noise(n_frames: int, *, batch_size: int = 1, hop_samples: int = HOP_SAMPLES_16K, seed: int = 20261122) -> Tuple[np.ndarray, np.ndarray]:
    """Generate deterministic `(env_rand, n_wb)` Gaussian noise inputs for `Tract2Vox-Lite` ONNX."""
    rng = np.random.default_rng(seed)
    env_rand = rng.standard_normal((batch_size, 2, n_frames * 2)).astype(np.float32)
    n_wb = rng.standard_normal((batch_size, 1, n_frames * hop_samples)).astype(np.float32)
    return np.ascontiguousarray(env_rand), np.ascontiguousarray(n_wb)


def extract_speech_mono(data: np.ndarray, sr: int) -> np.ndarray:
    """Convert mono or multi-channel audio to mono speech, stripping an EGG channel if present."""
    arr = np.asarray(data, dtype=np.float32)
    if arr.ndim == 1:
        return arr
    if arr.shape[1] == 1:
        return arr[:, 0]
    if arr.shape[1] == 2:
        c0, c1 = arr[:, 0], arr[:, 1]
        s0, s1 = float(np.std(c0)), float(np.std(c1))
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
    """Pure-NumPy / soundfile / ffmpeg audio loader returning mono float32 @ 16 kHz."""
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
            [ff, "-v", "error", "-i", str(audio_path), "-ac", "1", "-ar", str(SAMPLE_RATE_16K), "-f", "f32le", "-"],
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
        raise ValueError(f"音频时长 {len(audio) / SAMPLE_RATE_16K:.1f}s 超过上限 {max_duration_sec:.1f}s")
    return audio


def _align_to_frame(sample_idx: int, hop_samples: int = HOP_SAMPLES_16K) -> int:
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
    return int(cands[int(np.argmin(energy))])


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
    hop_align = max(1, int(round(sr * 0.02)))
    max_sec = max(2.0, float(max_chunk_sec))
    min_sec = min(max(0.5, float(min_chunk_sec)), max_sec * 0.65)
    target_sec = float(np.clip(target_chunk_sec, min_sec + 0.4, max(min_sec + 0.5, max_sec - 0.3)))
    max_samp = max(hop_align * 2, _align_to_frame(int(round(max_sec * sr)), hop_align))
    min_samp = max(hop_align, min(max_samp - hop_align, _align_to_frame(int(round(min_sec * sr)), hop_align)))

    if n <= max_samp:
        return [{"index": 0, "start_16k": 0, "end_16k": n, "start_sec": 0.0, "end_sec": round(n / sr, 3), "split_reason": "single"}]

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
                intervals.append((int(starts[run_start]), int(starts[i - 1] + win), float(np.min(rms_db[run_start:i]))))
            run_start = None
    if run_start is not None and len(silent_mask) - run_start >= min_hops:
        intervals.append((int(starts[run_start]), int(starts[len(silent_mask) - 1] + win), float(np.min(rms_db[run_start:]))))

    chunks: List[Dict[str, Any]] = []
    cursor = 0
    while cursor < n:
        rem = n - cursor
        if rem <= max_samp:
            chunks.append({
                "index": len(chunks),
                "start_16k": cursor,
                "end_16k": n,
                "start_sec": round(cursor / sr, 3),
                "end_sec": round(n / sr, 3),
                "split_reason": "tail" if chunks else "single",
            })
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
            score = dur_s * 1.5 - abs(mid_rel_s - eff_target_sec) * 0.35 - min_db * 0.03
            if score > best_score:
                best_score = score
                best_iv = (iv_start, iv_end, min_db)

        if best_iv is not None:
            split_pt = _align_to_frame(int(round(0.5 * (best_iv[0] + best_iv[1]))), hop_align)
            split_pt = max(win_lo, min(win_hi, split_pt))
            reason = "silence"
        else:
            split_pt = _pick_quietest_split(cs, n, win_lo, win_hi, hop_align, sr)
            reason = "low_energy"
        if split_pt <= cursor:
            split_pt = min(n, cursor + max_samp)
        chunks.append({
            "index": len(chunks),
            "start_16k": cursor,
            "end_16k": split_pt,
            "start_sec": round(cursor / sr, 3),
            "end_sec": round(split_pt / sr, 3),
            "split_reason": reason,
        })
        cursor = split_pt
    return chunks
