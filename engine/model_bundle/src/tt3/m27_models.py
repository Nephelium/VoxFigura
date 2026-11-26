"""Full-native 27-dim neural components: VoiceQualityFrontend50Hz, PressureEncoder27,
Dual-Layer AcousticDecoder27, and Dual-Branch Decoupled Motor27.
"""
from __future__ import annotations

from typing import Dict, Optional, Tuple

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

from .constants import SAMPLE_RATE_16K, WAVLM_HOP_SAMPLES
from .m27_contract import GLOTTIS8_NAMES, TRACT17_NAMES
from .models import (
    ConformerBlock,
    ConvNeXtBlock1D,
    LayerWeightedSum,
    _run_masked_bilstm,
    normalize_waveform_for_wavlm,
)


class VoiceQualityFrontend50Hz(nn.Module):
    """Pure-PyTorch 50 Hz explicit voice-quality cues aligned 1:1 with WavLM frames.

    Extracts 3 compact, speaker-invariant cues:
      0: relative log-RMS energy (distinguishes silence, glottal stop, weak creak, strong pressed)
      1: spectral tilt log(E_high[2–7.6 kHz] / E_low[60–1000 Hz]) (breathy/falsetto vs modal vs pressed)
      2: local frame-to-frame |Δlog-RMS| energy flux (creaky pulse irregularity & shimmer modulation)
    """

    def __init__(
        self,
        sr: int = SAMPLE_RATE_16K,
        n_fft: int = 1024,
        win_length: int = 640,
        hop_length: int = WAVLM_HOP_SAMPLES,
    ) -> None:
        super().__init__()
        self.sr = int(sr)
        self.n_fft = int(n_fft)
        self.win_length = int(win_length)
        self.hop_length = int(hop_length)
        self.register_buffer("window", torch.hann_window(self.win_length), persistent=True)
        freqs = np.linspace(0.0, sr / 2.0, self.n_fft // 2 + 1, dtype=np.float32)
        self.register_buffer(
            "lf_mask",
            torch.from_numpy(((freqs >= 60.0) & (freqs <= 1000.0)).astype(np.float32)),
            persistent=True,
        )
        self.register_buffer(
            "hf_mask",
            torch.from_numpy(((freqs >= 2000.0) & (freqs <= 7600.0)).astype(np.float32)),
            persistent=True,
        )

    @torch.no_grad()
    def forward(
        self,
        wav_16k: torch.Tensor,
        valid_mask: Optional[torch.Tensor] = None,
    ) -> torch.Tensor:
        # wav_16k: (B, T * 320) float32 -> returns (B, T, 3) float32
        x = wav_16k.float()
        bsz, n_samples = x.shape
        target_frames = n_samples // self.hop_length

        valid_samples = None
        if valid_mask is not None:
            valid_samples = valid_mask.sum(dim=1).long() * self.hop_length
        normed = normalize_waveform_for_wavlm(x, valid_samples)

        pad_left = (self.n_fft - self.hop_length) // 2
        pad_right = self.n_fft - self.hop_length - pad_left
        padded = F.pad(
            normed,
            (pad_left, pad_right),
            mode="reflect" if n_samples > max(pad_left, pad_right) else "constant",
        )
        spec = torch.stft(
            padded,
            n_fft=self.n_fft,
            hop_length=self.hop_length,
            win_length=self.win_length,
            window=self.window,
            center=False,
            return_complex=True,
        )
        power = spec.real.square() + spec.imag.square()  # (B, F, T_out)
        if power.shape[-1] > target_frames:
            power = power[..., :target_frames]
        elif power.shape[-1] < target_frames:
            power = F.pad(power, (0, target_frames - power.shape[-1]))

        # 1. Relative log-RMS energy
        frame_energy = power.mean(dim=1)  # (B, T)
        log_rms = 0.5 * torch.log(frame_energy.clamp(min=1e-8))
        if valid_mask is not None:
            m = valid_mask.bool()
            ref = torch.where(m, log_rms, torch.full_like(log_rms, -20.0)).quantile(0.95, dim=1, keepdim=True)
        else:
            ref = log_rms.quantile(0.95, dim=1, keepdim=True)
        rel_rms = ((log_rms - ref) / 3.0).clamp(-2.5, 1.0)

        # 2. Spectral tilt: HF / LF log-energy ratio
        lf = (power * self.lf_mask.view(1, -1, 1)).sum(dim=1) / self.lf_mask.sum().clamp(min=1.0)
        hf = (power * self.hf_mask.view(1, -1, 1)).sum(dim=1) / self.hf_mask.sum().clamp(min=1.0)
        tilt = (torch.log(hf.clamp(min=1e-8)) - torch.log(lf.clamp(min=1e-8))) / 4.0
        tilt = tilt.clamp(-2.5, 2.5)

        # 3. Local frame-to-frame |Δlog-RMS| flux (exposes vocal fry & shimmer jitter)
        lr_pad = F.pad(log_rms.unsqueeze(1), (1, 1), mode="replicate").squeeze(1)
        flux = (0.5 * (lr_pad[:, 2:] - lr_pad[:, :-2])).abs().clamp(0.0, 3.0)

        cues = torch.stack([rel_rms, tilt, flux], dim=-1)  # (B, T, 3)
        if valid_mask is not None:
            cues = cues * valid_mask.unsqueeze(-1).to(cues.dtype)
        return cues


class PressureEncoder27(nn.Module):
    """Full-range (0..16000 dPa) subglottal pressure encoder: 25-layer WavLM + 3-dim VQ cues."""

    def __init__(
        self,
        wavlm_dim: int = 1024,
        hidden_dim: int = 192,
        num_blocks: int = 8,
        kernel_size: int = 31,
    ) -> None:
        super().__init__()
        self.vq_frontend = VoiceQualityFrontend50Hz()
        self.layer_sum = LayerWeightedSum(25)
        self.in_proj = nn.Conv1d(wavlm_dim + 3, hidden_dim, kernel_size=1)
        self.blocks = nn.ModuleList(
            [ConvNeXtBlock1D(dim=hidden_dim, expansion=4, kernel_size=kernel_size) for _ in range(num_blocks)]
        )
        self.lstm = nn.LSTM(
            input_size=hidden_dim,
            hidden_size=hidden_dim,
            num_layers=1,
            batch_first=True,
            bidirectional=True,
        )
        self.out_proj = nn.Conv1d(hidden_dim * 2, 1, kernel_size=1)

    def forward(
        self,
        wavlm_25: torch.Tensor,
        wav_16k: torch.Tensor,
        valid_mask: Optional[torch.Tensor] = None,
    ) -> torch.Tensor:
        w = self.layer_sum(wavlm_25)  # (B, T, 1024)
        vq = self.vq_frontend(wav_16k, valid_mask).to(w.dtype)  # (B, T, 3)
        x = torch.cat([w, vq], dim=-1)
        x = self.in_proj(x.transpose(1, 2)).transpose(1, 2)
        if valid_mask is not None:
            x = x * valid_mask.unsqueeze(-1).to(x.dtype)
        for blk in self.blocks:
            x = blk(x)
            if valid_mask is not None:
                x = x * valid_mask.unsqueeze(-1).to(x.dtype)
        x = _run_masked_bilstm(self.lstm, x, valid_mask)
        out = torch.tanh(self.out_proj(x.transpose(1, 2)).transpose(1, 2))
        if valid_mask is not None:
            out = out * valid_mask.unsqueeze(-1).to(out.dtype)
        return out  # (B, T, 1)


def normalize_wavlm_l6_target(w25: torch.Tensor) -> torch.Tensor:
    """Scale-aligned Layer 6 target matching Layer 24's ~0.25 std so L_W24 and L_W6 share loss scale."""
    return F.layer_norm(w25[:, 6, :, :], (w25.shape[-1],)) * 0.25


class AcousticDecoder27(nn.Module):
    """Differentiable M10 R21 neural surrogate: m27_norm (B, T, 27) -> (WavLM L24, scaled WavLM L6).

    Predicting both L24 (phonetic/articulatory) and L6 (voice-quality/spectral-tilt/timbre) ensures
    Stage 3B glottis refinement and Stage 4 natural-speech Re-synthesis receive strong gradients
    for both vocal tract articulation AND phonation type!
    """

    def __init__(
        self,
        in_channels: int = 27,
        hidden_dim: int = 256,
        out_channels: int = 1024,
        num_layers: int = 8,
        num_heads: int = 4,
        kernel_size: int = 31,
        dropout: float = 0.1,
    ) -> None:
        super().__init__()
        self.in_proj = nn.Conv1d(in_channels, hidden_dim, kernel_size=1)
        self.blocks = nn.ModuleList(
            [
                ConformerBlock(
                    dim=hidden_dim,
                    heads=num_heads,
                    ff_mult=4,
                    conv_kernel_size=kernel_size,
                    dropout=dropout,
                )
                for _ in range(num_layers)
            ]
        )
        self.head_l24 = nn.Conv1d(hidden_dim, out_channels, kernel_size=1)
        self.head_l6 = nn.Conv1d(hidden_dim, out_channels, kernel_size=1)

    def forward(
        self,
        m27_norm: torch.Tensor,
        valid_mask: Optional[torch.Tensor] = None,
    ) -> Tuple[torch.Tensor, torch.Tensor]:
        x = self.in_proj(m27_norm.transpose(1, 2)).transpose(1, 2)
        if valid_mask is not None:
            x = x * valid_mask.unsqueeze(-1).to(x.dtype)
        for blk in self.blocks:
            x = blk(x, valid_mask=valid_mask)
        xt = x.transpose(1, 2)
        w24_hat = self.head_l24(xt).transpose(1, 2)
        w6_hat = self.head_l6(xt).transpose(1, 2)
        if valid_mask is not None:
            m = valid_mask.unsqueeze(-1).to(w24_hat.dtype)
            w24_hat = w24_hat * m
            w6_hat = w6_hat * m
        return w24_hat, w6_hat


class TractBranch27(nn.Module):
    """Supraglottal vocal-tract branch: 25-layer WavLM -> Conformer(256)x8 + BiLSTM -> 17 tract dims."""

    def __init__(
        self,
        wavlm_dim: int = 1024,
        hidden_dim: int = 256,
        num_layers: int = 8,
        num_heads: int = 4,
        kernel_size: int = 31,
        dropout: float = 0.1,
    ) -> None:
        super().__init__()
        self.layer_sum = LayerWeightedSum(25)
        # Gentle prior favoring upper-mid/top phonetic layers (fully learnable)
        with torch.no_grad():
            self.layer_sum.logits.copy_(torch.linspace(-0.5, 0.8, 25))
        self.in_proj = nn.Conv1d(wavlm_dim, hidden_dim, kernel_size=1)
        self.blocks = nn.ModuleList(
            [
                ConformerBlock(
                    dim=hidden_dim,
                    heads=num_heads,
                    ff_mult=4,
                    conv_kernel_size=kernel_size,
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
        self.out_proj = nn.Conv1d(hidden_dim * 2, 17, kernel_size=1)

    def forward(
        self,
        wavlm_25: torch.Tensor,
        valid_mask: Optional[torch.Tensor] = None,
    ) -> torch.Tensor:
        x = self.layer_sum(wavlm_25)
        x = self.in_proj(x.transpose(1, 2)).transpose(1, 2)
        if valid_mask is not None:
            x = x * valid_mask.unsqueeze(-1).to(x.dtype)
        for blk in self.blocks:
            x = blk(x, valid_mask=valid_mask)
        x = _run_masked_bilstm(self.lstm, x, valid_mask)
        out = torch.tanh(self.out_proj(x.transpose(1, 2)).transpose(1, 2))
        if valid_mask is not None:
            out = out * valid_mask.unsqueeze(-1).to(out.dtype)
        return out  # (B, T, 17)


class GlottisBranch27(nn.Module):
    """Voice-quality & glottis branch: 25-layer WavLM + [F0, PR, VQ_cues] -> 8 source dims."""

    def __init__(
        self,
        wavlm_dim: int = 1024,
        cond_dim: int = 5,  # f0_norm + pr_norm + 3 VQ cues
        hidden_dim: int = 192,
        num_layers: int = 6,
        num_heads: int = 4,
        kernel_size: int = 31,
        dropout: float = 0.1,
    ) -> None:
        super().__init__()
        self.layer_sum = LayerWeightedSum(25)
        # Gentle prior favoring lower/mid acoustic & timbre layers (fully learnable)
        with torch.no_grad():
            self.layer_sum.logits.copy_(torch.linspace(0.6, -0.4, 25))
        self.in_proj = nn.Conv1d(wavlm_dim + cond_dim, hidden_dim, kernel_size=1)
        self.blocks = nn.ModuleList(
            [
                ConformerBlock(
                    dim=hidden_dim,
                    heads=num_heads,
                    ff_mult=4,
                    conv_kernel_size=kernel_size,
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
        self.out_proj = nn.Conv1d(hidden_dim * 2, 8, kernel_size=1)

    def forward(
        self,
        wavlm_25: torch.Tensor,
        f0_norm: torch.Tensor,
        pr_norm: torch.Tensor,
        vq_cues: torch.Tensor,
        valid_mask: Optional[torch.Tensor] = None,
    ) -> torch.Tensor:
        w = self.layer_sum(wavlm_25)
        if f0_norm.ndim == 2:
            f0_norm = f0_norm.unsqueeze(-1)
        if pr_norm.ndim == 2:
            pr_norm = pr_norm.unsqueeze(-1)
        x = torch.cat([w, f0_norm.to(w.dtype), pr_norm.to(w.dtype), vq_cues.to(w.dtype)], dim=-1)
        x = self.in_proj(x.transpose(1, 2)).transpose(1, 2)
        if valid_mask is not None:
            x = x * valid_mask.unsqueeze(-1).to(x.dtype)
        for blk in self.blocks:
            x = blk(x, valid_mask=valid_mask)
        x = _run_masked_bilstm(self.lstm, x, valid_mask)
        out = torch.tanh(self.out_proj(x.transpose(1, 2)).transpose(1, 2))
        if valid_mask is not None:
            out = out * valid_mask.unsqueeze(-1).to(out.dtype)
        return out  # (B, T, 8) = [XB, XT, CA, LAG, RA, PS, FL, SHIM]


class DualBranchMotor27(nn.Module):
    """Decoupled dual-branch articulatory + full-native glottis motor inverter."""

    def __init__(
        self,
        tract_dim: int = 256,
        tract_layers: int = 8,
        glottis_dim: int = 192,
        glottis_layers: int = 6,
        dropout: float = 0.1,
    ) -> None:
        super().__init__()
        self.vq_frontend = VoiceQualityFrontend50Hz()
        self.tract_branch = TractBranch27(hidden_dim=tract_dim, num_layers=tract_layers, dropout=dropout)
        self.glottis_branch = GlottisBranch27(hidden_dim=glottis_dim, num_layers=glottis_layers, dropout=dropout)
        self._tract_trainable = True
        self._glottis_trainable = True

    def set_trainable(self, *, tract: bool, glottis: bool) -> None:
        self._tract_trainable = bool(tract)
        self._glottis_trainable = bool(glottis)
        for p in self.tract_branch.parameters():
            p.requires_grad_(self._tract_trainable)
        for p in self.glottis_branch.parameters():
            p.requires_grad_(self._glottis_trainable)
        self.tract_branch.train(self._tract_trainable)
        self.glottis_branch.train(self._glottis_trainable)

    def train(self, mode: bool = True):
        super().train(mode)
        # Keep any frozen branch strictly in eval() so BatchNorm running stats never drift!
        if mode:
            self.tract_branch.train(self._tract_trainable)
            self.glottis_branch.train(self._glottis_trainable)
        return self

    def forward(
        self,
        wavlm_25: torch.Tensor,
        wav_16k: torch.Tensor,
        f0_norm: torch.Tensor,
        pr_norm: torch.Tensor,
        valid_mask: Optional[torch.Tensor] = None,
    ) -> Tuple[torch.Tensor, torch.Tensor]:
        vq_cues = self.vq_frontend(wav_16k, valid_mask)
        if not self._tract_trainable:
            with torch.no_grad():
                tract17 = self.tract_branch(wavlm_25, valid_mask)
        else:
            tract17 = self.tract_branch(wavlm_25, valid_mask)

        if not self._glottis_trainable:
            with torch.no_grad():
                glottis8 = self.glottis_branch(wavlm_25, f0_norm, pr_norm, vq_cues, valid_mask)
        else:
            glottis8 = self.glottis_branch(wavlm_25, f0_norm, pr_norm, vq_cues, valid_mask)
        return tract17, glottis8


def _weighted_masked_mse(
    pred: torch.Tensor,
    target: torch.Tensor,
    valid_mask: torch.Tensor,
    dim_weights: Optional[torch.Tensor] = None,
) -> torch.Tensor:
    # pred, target: (B, T, D); valid_mask: (B, T); dim_weights: optional (B, D)
    sq = (pred - target) ** 2
    w = valid_mask.unsqueeze(-1).to(sq.dtype)
    if dim_weights is not None:
        w = w * dim_weights.unsqueeze(1).to(sq.dtype)
        denom = w.sum().clamp(min=1.0)
    else:
        denom = (w.sum() * pred.shape[-1]).clamp(min=1.0)
    return (sq * w).sum() / denom


def weighted_motor_domain_loss(
    pred: torch.Tensor,
    target: torch.Tensor,
    valid_mask: torch.Tensor,
    *,
    dim_weights: Optional[torch.Tensor] = None,
    beta0: float = 1.0,
    beta1: float = 10.0,
    beta2: float = 100.0,
) -> Tuple[torch.Tensor, Dict[str, float]]:
    """Motor parameter-domain loss supporting per-sample per-dimension selective masking."""
    l0 = _weighted_masked_mse(pred, target, valid_mask, dim_weights)

    m1 = valid_mask[:, 1:] * valid_mask[:, :-1]
    l1 = _weighted_masked_mse(pred[:, 1:] - pred[:, :-1], target[:, 1:] - target[:, :-1], m1, dim_weights)

    m2 = valid_mask[:, 2:] * valid_mask[:, 1:-1] * valid_mask[:, :-2]
    d2_p = pred[:, 2:] - 2.0 * pred[:, 1:-1] + pred[:, :-2]
    d2_t = target[:, 2:] - 2.0 * target[:, 1:-1] + target[:, :-2]
    l2 = _weighted_masked_mse(d2_p, d2_t, m2, dim_weights)

    total = beta0 * l0 + beta1 * l1 + beta2 * l2
    return total, {"l0": float(l0.detach()), "l1": float(l1.detach()), "l2": float(l2.detach())}


def masked_cosine_similarity(pred: torch.Tensor, target: torch.Tensor, valid_mask: torch.Tensor) -> float:
    cos = F.cosine_similarity(pred.float(), target.float(), dim=-1)  # (B, T)
    m = valid_mask.float()
    return float((cos * m).sum().item() / max(1.0, float(m.sum().item())))


def batch_per_dim_pcc(
    preds: np.ndarray,
    targets: np.ndarray,
) -> np.ndarray:
    """Compute Pearson correlation per column over flattened valid frames (N, D)."""
    d = preds.shape[1]
    out = np.zeros(d, dtype=np.float64)
    for c in range(d):
        x = preds[:, c].astype(np.float64)
        y = targets[:, c].astype(np.float64)
        xm = x - x.mean()
        ym = y - y.mean()
        denom = float(np.sqrt(np.sum(xm * xm) * np.sum(ym * ym)))
        out[c] = float(np.sum(xm * ym) / denom) if denom > 1e-12 else 0.0
    return out


def summarize_tract17_pcc(pcc17: np.ndarray) -> Dict[str, float]:
    return {name: round(float(pcc17[i]), 4) for i, name in enumerate(TRACT17_NAMES)}


def summarize_glottis8_pcc(pcc8: np.ndarray) -> Dict[str, float]:
    return {name: round(float(pcc8[i]), 4) for i, name in enumerate(GLOTTIS8_NAMES)}


# Official unified model class aliases (backward-compatible)
Vox2TractPR = PressureEncoder27
Tract2FeatProxy = AcousticDecoder27
Vox2TractLarge = DualBranchMotor27
