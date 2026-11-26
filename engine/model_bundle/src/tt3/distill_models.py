"""Lightweight distillation models for browser / mobile articulatory inversion."""
from __future__ import annotations

from typing import Optional

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

from .constants import SAMPLE_RATE_16K, WAVLM_HOP_SAMPLES
from .models import ConformerBlock, _run_masked_bilstm, normalize_waveform_for_wavlm


def _hz_to_mel_slaney(hz: np.ndarray) -> np.ndarray:
    f_min = 0.0
    f_sp = 200.0 / 3.0
    min_log_hz = 1000.0
    min_log_mel = (min_log_hz - f_min) / f_sp
    logstep = np.log(6.4) / 27.0
    hz = np.asarray(hz, dtype=np.float64)
    mels = (hz - f_min) / f_sp
    log_mask = hz >= min_log_hz
    mels[log_mask] = min_log_mel + np.log(hz[log_mask] / min_log_hz) / logstep
    return mels


def _mel_to_hz_slaney(mels: np.ndarray) -> np.ndarray:
    f_min = 0.0
    f_sp = 200.0 / 3.0
    min_log_hz = 1000.0
    min_log_mel = (min_log_hz - f_min) / f_sp
    logstep = np.log(6.4) / 27.0
    mels = np.asarray(mels, dtype=np.float64)
    hz = f_min + f_sp * mels
    log_mask = mels >= min_log_mel
    hz[log_mask] = min_log_hz * np.exp(logstep * (mels[log_mask] - min_log_mel))
    return hz


def build_mel_filterbank(
    sr: int = SAMPLE_RATE_16K,
    n_fft: int = 1024,
    n_mels: int = 80,
    f_min: float = 40.0,
    f_max: float = 7600.0,
) -> np.ndarray:
    """Slaney-normalized Mel filterbank of shape (n_mels, n_fft // 2 + 1)."""
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
        enorm = 2.0 / max(1e-8, right - left)
        fb[i] *= enorm
    return fb.astype(np.float32)


class PureLogMel50Hz(nn.Module):
    """Pure-PyTorch 50 Hz Log-Mel + Delta (+ optional relative energy/HF-LF ratio) frontend."""

    def __init__(
        self,
        sr: int = SAMPLE_RATE_16K,
        n_fft: int = 1024,
        win_length: int = 640,
        hop_length: int = WAVLM_HOP_SAMPLES,
        n_mels: int = 80,
        f_min: float = 40.0,
        f_max: float = 7600.0,
        use_energy_feats: bool = True,
    ) -> None:
        super().__init__()
        self.sr = int(sr)
        self.n_fft = int(n_fft)
        self.win_length = int(win_length)
        self.hop_length = int(hop_length)
        self.n_mels = int(n_mels)
        self.use_energy_feats = bool(use_energy_feats)
        self.out_dim = self.n_mels * 2 + (3 if self.use_energy_feats else 0)

        fb = build_mel_filterbank(sr=sr, n_fft=n_fft, n_mels=n_mels, f_min=f_min, f_max=f_max)
        self.register_buffer("mel_fb", torch.from_numpy(fb), persistent=True)
        self.register_buffer("window", torch.hann_window(self.win_length), persistent=True)
        freqs = np.linspace(0.0, sr / 2.0, self.n_fft // 2 + 1, dtype=np.float32)
        self.register_buffer("lf_mask", torch.from_numpy(((freqs >= 60.0) & (freqs <= 1000.0)).astype(np.float32)), persistent=True)
        self.register_buffer("hf_mask", torch.from_numpy(((freqs >= 2000.0) & (freqs <= 7600.0)).astype(np.float32)), persistent=True)

    def forward(
        self,
        wav_16k: torch.Tensor,
        valid_mask_50hz: Optional[torch.Tensor] = None,
    ) -> torch.Tensor:
        """
        Args:
            wav_16k: (B, T * 320) float32 mono waveform @ 16 kHz
            valid_mask_50hz: optional (B, T) float/bool mask
        Returns:
            feats: (B, T, out_dim) aligned 1:1 with 50 Hz frames
        """
        bsz, n_samples = wav_16k.shape
        target_frames = n_samples // self.hop_length

        valid_samples = None
        if valid_mask_50hz is not None:
            valid_samples = valid_mask_50hz.sum(dim=1).long() * self.hop_length
        normed = normalize_waveform_for_wavlm(wav_16k.float(), valid_samples)

        # Center each 50 Hz frame at (k + 0.5) * hop_length to align with WavLM's 20 ms grid.
        pad_left = (self.n_fft - self.hop_length) // 2
        pad_right = self.n_fft - self.hop_length - pad_left
        padded = F.pad(normed, (pad_left, pad_right), mode="reflect" if n_samples > max(pad_left, pad_right) else "constant")

        spec = torch.stft(
            padded,
            n_fft=self.n_fft,
            hop_length=self.hop_length,
            win_length=self.win_length,
            window=self.window,
            center=False,
            return_complex=True,
        )
        power = spec.real.square() + spec.imag.square()  # (B, n_freqs, T_out)
        if power.shape[-1] > target_frames:
            power = power[..., :target_frames]
        elif power.shape[-1] < target_frames:
            power = F.pad(power, (0, target_frames - power.shape[-1]))

        mel = torch.matmul(self.mel_fb, power)           # (B, n_mels, T)
        log_mel = torch.log(mel.clamp(min=1e-6))         # (B, n_mels, T)

        # Per-utterance standardization over valid frames for speaker/mic invariance.
        x = log_mel.transpose(1, 2)  # (B, T, n_mels)
        if valid_mask_50hz is not None:
            m = valid_mask_50hz.unsqueeze(-1).to(x.dtype)
            denom = m.sum(dim=1, keepdim=True).clamp(min=1.0)
            mean = (x * m).sum(dim=1, keepdim=True) / denom
            diff = (x - mean) * m
            std = torch.sqrt((diff * diff).sum(dim=1, keepdim=True) / denom + 1e-5)
            x = ((x - mean) / std) * m
        else:
            mean = x.mean(dim=1, keepdim=True)
            std = torch.sqrt(x.var(dim=1, unbiased=False, keepdim=True) + 1e-5)
            x = (x - mean) / std

        # First-order temporal delta (helps plosive bursts & formant transitions).
        x_pad = F.pad(x.transpose(1, 2), (1, 1), mode="replicate").transpose(1, 2)
        delta = 0.5 * (x_pad[:, 2:, :] - x_pad[:, :-2, :])
        if valid_mask_50hz is not None:
            delta = delta * valid_mask_50hz.unsqueeze(-1).to(delta.dtype)

        if not self.use_energy_feats:
            return torch.cat([x, delta], dim=-1)

        # 3-dim gain-invariant physical energy / voicing cues (preserve silence vs speech contrast for PR):
        # 1) Frame dB relative to utterance 95th-percentile peak dB, mapped [-60, 0] dB -> [-1, 1]
        frame_energy = power.mean(dim=1)  # (B, T)
        frame_db = 10.0 * torch.log10(frame_energy.clamp(min=1e-10))  # (B, T)
        if valid_mask_50hz is not None:
            valid_b = valid_mask_50hz > 0.5
            # Replace padded frames with very low dB so they never distort the 95th-percentile peak.
            masked_db = torch.where(valid_b, frame_db, torch.full_like(frame_db, -120.0))
        else:
            masked_db = frame_db
        k_idx = max(1, int(round(0.95 * target_frames)))
        sorted_db, _ = torch.sort(masked_db, dim=1)
        peak_db = sorted_db[:, k_idx - 1 : k_idx]  # (B, 1)
        rel_db = (frame_db - peak_db).clamp(min=-60.0, max=0.0)
        rel_db_norm = (rel_db / 30.0) + 1.0  # [-60, 0] -> [-1, 1]

        # 2) First-order energy delta (onset/offset slope)
        e_pad = F.pad(rel_db_norm.unsqueeze(1), (1, 1), mode="replicate").squeeze(1)
        delta_e = (0.5 * (e_pad[:, 2:] - e_pad[:, :-2])).clamp(min=-1.0, max=1.0)

        # 3) High-to-low frequency log energy ratio (voicing vs frication/aspiration/noise)
        lf_e = (power * self.lf_mask.view(1, -1, 1)).sum(dim=1) / self.lf_mask.sum().clamp(min=1.0)
        hf_e = (power * self.hf_mask.view(1, -1, 1)).sum(dim=1) / self.hf_mask.sum().clamp(min=1.0)
        hf_lf = (10.0 * torch.log10((hf_e + 1e-10) / (lf_e + 1e-10)) / 30.0).clamp(min=-1.0, max=1.0)

        energy_feats = torch.stack([rel_db_norm, delta_e, hf_lf], dim=-1)  # (B, T, 3)
        if valid_mask_50hz is not None:
            energy_feats = energy_feats * valid_mask_50hz.unsqueeze(-1).to(energy_feats.dtype)
        return torch.cat([x, delta, energy_feats], dim=-1)


class BrowserLightInverter(nn.Module):
    """Ultra-light browser-ready inverter: 16 kHz wav -> Log-Mel+Delta+Energy -> Conv -> Conformer + BiLSTM -> [m20, PR]."""

    def __init__(
        self,
        n_mels: int = 80,
        hidden_dim: int = 160,
        num_layers: int = 6,
        num_heads: int = 4,
        conv_kernel_size: int = 31,
        dropout: float = 0.05,
        out_channels: int = 21,  # 20 m20 + 1 PR
        use_energy_feats: bool = True,
    ) -> None:
        super().__init__()
        self.use_energy_feats = bool(use_energy_feats)
        self.mel = PureLogMel50Hz(n_mels=n_mels, use_energy_feats=self.use_energy_feats)
        in_dim = self.mel.out_dim
        self.stem = nn.Sequential(
            nn.Conv1d(in_dim, hidden_dim, kernel_size=5, padding=2),
            nn.GELU(),
            nn.Conv1d(hidden_dim, hidden_dim, kernel_size=3, padding=1),
            nn.GELU(),
        )
        self.stem_norm = nn.LayerNorm(hidden_dim)
        self.blocks = nn.ModuleList(
            [
                ConformerBlock(
                    dim=hidden_dim,
                    heads=num_heads,
                    ff_mult=4,
                    conv_kernel_size=conv_kernel_size,
                    dropout=dropout,
                )
                for _ in range(num_layers)
            ]
        )
        self.lstm = nn.LSTM(
            input_size=hidden_dim,
            hidden_size=hidden_dim,
            num_layers=1,
            batch_first=True,
            bidirectional=True,
        )
        self.out_proj = nn.Conv1d(hidden_dim * 2, out_channels, kernel_size=1)

    def forward(
        self,
        wav_16k: torch.Tensor,
        valid_mask: Optional[torch.Tensor] = None,
    ) -> torch.Tensor:
        """
        Args:
            wav_16k: (B, T * 320) 16 kHz float32 waveform
            valid_mask: optional (B, T) float/bool valid-frame mask
        Returns:
            m21_norm: (B, T, 21) in [-1, 1], where [:, :, :20] is m20 and [:, :, 20:21] is PR
        """
        feats = self.mel(wav_16k, valid_mask_50hz=valid_mask)  # (B, T, 160)
        x = self.stem(feats.transpose(1, 2)).transpose(1, 2)
        x = self.stem_norm(x)
        if valid_mask is not None:
            x = x * valid_mask.unsqueeze(-1).to(x.dtype)
        for blk in self.blocks:
            x = blk(x, valid_mask=valid_mask)
        x = _run_masked_bilstm(self.lstm, x, valid_mask)
        out = torch.tanh(self.out_proj(x.transpose(1, 2)).transpose(1, 2))
        if valid_mask is not None:
            out = out * valid_mask.unsqueeze(-1).to(out.dtype)
        return out
