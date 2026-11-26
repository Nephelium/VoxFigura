"""Self-contained pure-PyTorch inference models for kf_ipa_synth (zero WavLM / transformers dependency).

Includes bit-exact inference implementations of:
  - KeyframeTractModel27       (4.23M Conformer-BiGRU, FP16 ~8.1 MB, INT8 ~4.2 MB)
  - BrowserLightSpeakerEncoder (2.9M ECAPA-TDNN aligned to 512-d WavLM-SV, FP16 ~5.7 MB, INT8 ~2.9 MB)
  - ConditionalHiFiGenerator27 (Stage5Lite 3.73M & Teacher 14.35M NSF-HiFiGAN vocoder)
  - Unified FP16 / per-channel INT8 / full checkpoint loaders
"""
from __future__ import annotations

import math
from pathlib import Path
from typing import Any, Dict, Optional, Sequence, Tuple

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.nn.utils.parametrizations import weight_norm

from .baseline import KF_COND_DIM, KF_OUT_DIM
from .m27_contract import (
    F0_IDX,
    HOP_SAMPLES_16K,
    LOG_F0_MAX_M27,
    LOG_F0_MIN_M27,
    PR_IDX,
    PR_MAX_M27,
    PR_MIN_M27,
    SAMPLE_RATE_16K,
)
from .phonetics import KF26_INDEX

LRELU_SLOPE = 0.1


# =============================================================================
# Shared Audio / Normalization Helpers
# =============================================================================
def normalize_waveform_for_wavlm(
    wav: torch.Tensor,
    valid_samples: Optional[torch.Tensor] = None,
) -> torch.Tensor:
    if valid_samples is None:
        mean = wav.mean(dim=-1, keepdim=True)
        var = wav.var(dim=-1, unbiased=False, keepdim=True)
        std = torch.sqrt(var + 1e-7)
        scale = torch.where(std > 1e-4, std, torch.ones_like(std))
        return (wav - mean) / scale

    bsz, max_len = wav.shape
    idx = torch.arange(max_len, device=wav.device).unsqueeze(0)
    mask = (idx < valid_samples.unsqueeze(1)).to(wav.dtype)
    denom = mask.sum(dim=-1, keepdim=True).clamp(min=1.0)
    mean = (wav * mask).sum(dim=-1, keepdim=True) / denom
    diff = (wav - mean) * mask
    var = (diff * diff).sum(dim=-1, keepdim=True) / denom
    std = torch.sqrt(var + 1e-7)
    scale = torch.where(std > 1e-4, std, torch.ones_like(std))
    return ((wav - mean) / scale) * mask


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
    return fb.astype(np.float32)


# =============================================================================
# 1. KF2Tract27 Trajectory Model (Conformer + BiGRU Residual)
# =============================================================================
class RelPosSelfAttention(nn.Module):
    def __init__(self, dim: int = 192, heads: int = 4, max_rel_dist: int = 512, dropout: float = 0.1) -> None:
        super().__init__()
        self.heads = heads
        self.head_dim = dim // heads
        self.scale = self.head_dim ** -0.5
        self.max_rel_dist = max_rel_dist
        self.to_qkv = nn.Linear(dim, dim * 3, bias=False)
        self.rel_emb = nn.Embedding(2 * max_rel_dist + 1, self.head_dim)
        self.to_out = nn.Linear(dim, dim)
        self.dropout = nn.Dropout(dropout)

    def forward(self, x: torch.Tensor, valid_mask: Optional[torch.Tensor] = None) -> torch.Tensor:
        bsz, seq_len, _ = x.shape
        qkv = self.to_qkv(x).view(bsz, seq_len, 3, self.heads, self.head_dim)
        q, k, v = qkv.unbind(dim=2)
        q = q.transpose(1, 2)
        k = k.transpose(1, 2)
        v = v.transpose(1, 2)

        dots = torch.matmul(q, k.transpose(-2, -1)) * self.scale
        pos = torch.arange(seq_len, device=x.device)
        rel_idx = (pos[:, None] - pos[None, :]).clamp(-self.max_rel_dist, self.max_rel_dist) + self.max_rel_dist
        rel_k = self.rel_emb(rel_idx)
        pos_bias = torch.einsum("b h i d, i j d -> b h i j", q, rel_k) * self.scale
        dots = dots + pos_bias

        if valid_mask is not None:
            key_mask = valid_mask.bool().view(bsz, 1, 1, seq_len)
            dots = dots.masked_fill(~key_mask, torch.finfo(dots.dtype).min)

        attn = self.dropout(torch.softmax(dots, dim=-1))
        out = torch.matmul(attn, v).transpose(1, 2).contiguous().view(bsz, seq_len, -1)
        return self.dropout(self.to_out(out))


class ConformerConvModule(nn.Module):
    def __init__(self, dim: int = 192, expansion: int = 2, kernel_size: int = 31, dropout: float = 0.1) -> None:
        super().__init__()
        inner = dim * expansion
        self.norm = nn.LayerNorm(dim)
        self.pw1 = nn.Conv1d(dim, inner * 2, kernel_size=1)
        self.dw = nn.Conv1d(inner, inner, kernel_size=kernel_size, padding=kernel_size // 2, groups=inner)
        self.bn = nn.BatchNorm1d(inner)
        self.pw2 = nn.Conv1d(inner, dim, kernel_size=1)
        self.drop = nn.Dropout(dropout)

    def forward(self, x: torch.Tensor, valid_mask: Optional[torch.Tensor] = None) -> torch.Tensor:
        h = self.norm(x).transpose(1, 2)
        a, b = self.pw1(h).chunk(2, dim=1)
        h = a * torch.sigmoid(b)
        if valid_mask is not None:
            h = h * valid_mask.unsqueeze(1).to(h.dtype)
        h = F.silu(self.bn(self.dw(h)))
        return self.drop(self.pw2(h).transpose(1, 2))


class ConformerBlock(nn.Module):
    def __init__(
        self,
        dim: int = 192,
        heads: int = 4,
        ff_mult: int = 4,
        conv_kernel_size: int = 31,
        dropout: float = 0.1,
    ) -> None:
        super().__init__()
        self.norm_ff1 = nn.LayerNorm(dim)
        self.ff1 = nn.Sequential(
            nn.Linear(dim, dim * ff_mult),
            nn.SiLU(),
            nn.Dropout(dropout),
            nn.Linear(dim * ff_mult, dim),
            nn.Dropout(dropout),
        )
        self.norm_attn = nn.LayerNorm(dim)
        self.attn = RelPosSelfAttention(dim=dim, heads=heads, dropout=dropout)
        self.conv = ConformerConvModule(dim=dim, kernel_size=conv_kernel_size, dropout=dropout)
        self.norm_ff2 = nn.LayerNorm(dim)
        self.ff2 = nn.Sequential(
            nn.Linear(dim, dim * ff_mult),
            nn.SiLU(),
            nn.Dropout(dropout),
            nn.Linear(dim * ff_mult, dim),
            nn.Dropout(dropout),
        )
        self.post_norm = nn.LayerNorm(dim)

    def forward(self, x: torch.Tensor, valid_mask: Optional[torch.Tensor] = None) -> torch.Tensor:
        x = x + 0.5 * self.ff1(self.norm_ff1(x))
        x = x + self.attn(self.norm_attn(x), valid_mask=valid_mask)
        x = x + self.conv(x, valid_mask=valid_mask)
        x = x + 0.5 * self.ff2(self.norm_ff2(x))
        x = self.post_norm(x)
        if valid_mask is not None:
            x = x * valid_mask.unsqueeze(-1).to(x.dtype)
        return x


class KeyframeTractModel27(nn.Module):
    """Lightweight bidirectional Conformer + BiGRU residual trajectory predictor."""

    def __init__(
        self,
        cond_dim: int = KF_COND_DIM,
        out_dim: int = KF_OUT_DIM,
        hidden_dim: int = 192,
        num_layers: int = 4,
        num_heads: int = 4,
        ff_mult: int = 3,
        conv_kernel_size: int = 15,
        dropout: float = 0.05,
        max_residual: float = 0.85,
    ) -> None:
        super().__init__()
        self.cond_dim = int(cond_dim)
        self.out_dim = int(out_dim)
        self.hidden_dim = int(hidden_dim)
        self.max_residual = float(max_residual)
        max_res_vec = np.full(self.out_dim, self.max_residual, dtype=np.float32)
        max_res_vec[KF26_INDEX["JA"]] = min(self.max_residual, 0.35)
        self.register_buffer("max_res_vec", torch.from_numpy(max_res_vec).view(1, 1, -1), persistent=True)

        self.in_proj = nn.Linear(self.cond_dim, hidden_dim)
        self.in_norm = nn.LayerNorm(hidden_dim)
        self.stem_conv = nn.Sequential(
            nn.Conv1d(hidden_dim, hidden_dim, kernel_size=5, padding=2),
            nn.GELU(),
        )
        self.blocks = nn.ModuleList(
            [
                ConformerBlock(
                    dim=hidden_dim,
                    heads=num_heads,
                    ff_mult=ff_mult,
                    conv_kernel_size=conv_kernel_size,
                    dropout=dropout,
                )
                for _ in range(num_layers)
            ]
        )
        self.gru = nn.GRU(
            input_size=hidden_dim,
            hidden_size=hidden_dim,
            num_layers=1,
            batch_first=True,
            bidirectional=True,
        )
        feat_dim = hidden_dim * 2
        self.tract_head = nn.Sequential(
            nn.LayerNorm(feat_dim),
            nn.Linear(feat_dim, 128),
            nn.GELU(),
            nn.Linear(128, 17),
        )
        self.source_head = nn.Sequential(
            nn.LayerNorm(feat_dim),
            nn.Linear(feat_dim, 96),
            nn.GELU(),
            nn.Linear(96, 9),
        )

    def forward(
        self,
        cond: torch.Tensor,
        x_base: torch.Tensor,
        valid_mask: Optional[torch.Tensor] = None,
        alpha: float = 1.0,
    ) -> Tuple[torch.Tensor, torch.Tensor]:
        h = self.in_norm(self.in_proj(cond))
        h = h + self.stem_conv(h.transpose(1, 2)).transpose(1, 2)
        if valid_mask is not None:
            h = h * valid_mask.unsqueeze(-1).to(h.dtype)
        for blk in self.blocks:
            h = blk(h, valid_mask=valid_mask)
        h, _ = self.gru(h)
        d_tract = torch.tanh(self.tract_head(h))
        d_src = torch.tanh(self.source_head(h))
        delta = torch.cat([d_tract, d_src], dim=-1) * self.max_res_vec.to(h.dtype)
        x_hat = torch.clamp(x_base + float(alpha) * delta, -1.0, 1.0)
        return x_hat, delta


# =============================================================================
# 2. SpkLite: Zero-WavLM ECAPA-TDNN Speaker Encoder (512-d)
# =============================================================================
class _SEBlock1D(nn.Module):
    def __init__(self, channels: int, bottleneck: int = 64) -> None:
        super().__init__()
        self.fc1 = nn.Conv1d(channels, bottleneck, kernel_size=1)
        self.fc2 = nn.Conv1d(bottleneck, channels, kernel_size=1)

    def forward(self, x: torch.Tensor, mask: Optional[torch.Tensor] = None) -> torch.Tensor:
        if mask is not None:
            m = mask.unsqueeze(1).to(x.dtype)
            s = (x * m).sum(dim=-1, keepdim=True) / m.sum(dim=-1, keepdim=True).clamp(min=1.0)
        else:
            s = x.mean(dim=-1, keepdim=True)
        return x * torch.sigmoid(self.fc2(F.silu(self.fc1(s))))


class _SERes2Block(nn.Module):
    def __init__(self, channels: int, kernel_size: int = 3, dilation: int = 2, scale: int = 4) -> None:
        super().__init__()
        self.scale = int(scale)
        self.width = channels // self.scale
        self.conv1 = nn.Conv1d(channels, channels, kernel_size=1)
        self.bn1 = nn.BatchNorm1d(channels)
        pad = (kernel_size - 1) * dilation // 2
        self.convs = nn.ModuleList(
            [
                nn.Conv1d(self.width, self.width, kernel_size=kernel_size, dilation=dilation, padding=pad)
                for _ in range(self.scale - 1)
            ]
        )
        self.bns = nn.ModuleList([nn.BatchNorm1d(self.width) for _ in range(self.scale - 1)])
        self.conv3 = nn.Conv1d(channels, channels, kernel_size=1)
        self.bn3 = nn.BatchNorm1d(channels)
        self.se = _SEBlock1D(channels, bottleneck=max(32, channels // 4))

    def forward(self, x: torch.Tensor, mask: Optional[torch.Tensor] = None) -> torch.Tensor:
        residual = x
        out = F.silu(self.bn1(self.conv1(x)))
        chunks = torch.split(out, self.width, dim=1)
        ys = [chunks[0]]
        for i in range(1, self.scale):
            sp = chunks[i] if i == 1 else (chunks[i] + ys[-1])
            ys.append(F.silu(self.bns[i - 1](self.convs[i - 1](sp))))
        out = self.bn3(self.conv3(torch.cat(ys, dim=1)))
        out = F.silu(self.se(out, mask=mask) + residual)
        if mask is not None:
            out = out * mask.unsqueeze(1).to(out.dtype)
        return out


class BrowserLightSpeakerEncoder(nn.Module):
    """Lightweight ECAPA-TDNN speaker encoder (~2.9M params) outputting L2-normalized 512-d vectors."""

    def __init__(
        self,
        sr: int = SAMPLE_RATE_16K,
        n_fft: int = 1024,
        win_length: int = 640,
        hop_length: int = HOP_SAMPLES_16K,
        n_mels: int = 80,
        channels: int = 384,
        mfa_dim: int = 512,
        emb_dim: int = 512,
    ) -> None:
        super().__init__()
        self.sr = int(sr)
        self.n_fft = int(n_fft)
        self.win_length = int(win_length)
        self.hop_length = int(hop_length)
        self.n_mels = int(n_mels)
        self.channels = int(channels)
        self.mfa_dim = int(mfa_dim)
        self.emb_dim = int(emb_dim)

        fb = build_mel_filterbank(sr=sr, n_fft=n_fft, n_mels=n_mels, f_min=40.0, f_max=7600.0)
        self.register_buffer("mel_fb", torch.from_numpy(fb), persistent=True)
        self.register_buffer("window", torch.hann_window(self.win_length), persistent=True)

        self.in_conv = nn.Sequential(
            nn.Conv1d(self.n_mels, self.channels, kernel_size=5, padding=2),
            nn.BatchNorm1d(self.channels),
            nn.SiLU(),
        )
        self.layer1 = _SERes2Block(self.channels, kernel_size=3, dilation=2, scale=4)
        self.layer2 = _SERes2Block(self.channels, kernel_size=3, dilation=3, scale=4)
        self.layer3 = _SERes2Block(self.channels, kernel_size=3, dilation=4, scale=4)
        self.mfa = nn.Sequential(nn.Conv1d(self.channels * 3, self.mfa_dim, kernel_size=1), nn.SiLU())
        self.attn = nn.Sequential(
            nn.Conv1d(self.mfa_dim * 3, 128, kernel_size=1),
            nn.Tanh(),
            nn.Conv1d(128, self.mfa_dim, kernel_size=1),
        )
        self.bn_pool = nn.BatchNorm1d(self.mfa_dim * 2)
        self.fc = nn.Linear(self.mfa_dim * 2, self.emb_dim)
        self.bn_out = nn.BatchNorm1d(self.emb_dim)

    @classmethod
    def from_arch_config(cls, cfg: Optional[Dict[str, Any]]) -> "BrowserLightSpeakerEncoder":
        if not cfg:
            return cls()
        allowed = ("sr", "n_fft", "win_length", "hop_length", "n_mels", "channels", "mfa_dim", "emb_dim")
        return cls(**{k: cfg[k] for k in allowed if k in cfg})

    def _extract_cmn_logmel(self, wav_16k: torch.Tensor) -> torch.Tensor:
        x = wav_16k.float()
        _, n_samples = x.shape
        target_frames = max(1, n_samples // self.hop_length)
        normed = normalize_waveform_for_wavlm(x, None)
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
        power = spec.real.square() + spec.imag.square()
        if power.shape[-1] > target_frames:
            power = power[..., :target_frames]
        elif power.shape[-1] < target_frames:
            power = F.pad(power, (0, target_frames - power.shape[-1]))
        mel = torch.matmul(self.mel_fb, power)
        log_mel = torch.log(mel.clamp(min=1e-6))
        return log_mel - log_mel.mean(dim=-1, keepdim=True)

    def forward(self, wav_16k: torch.Tensor) -> torch.Tensor:
        x = self.in_conv(self._extract_cmn_logmel(wav_16k))
        x1 = self.layer1(x)
        x2 = self.layer2(x1)
        x3 = self.layer3(x2)
        h = self.mfa(torch.cat([x1, x2, x3], dim=1))
        g_mean = h.mean(dim=-1, keepdim=True)
        g_std = torch.sqrt(h.var(dim=-1, unbiased=False, keepdim=True) + 1e-5)
        t_len = h.shape[-1]
        attn_in = torch.cat([h, g_mean.expand(-1, -1, t_len), g_std.expand(-1, -1, t_len)], dim=1)
        w = torch.softmax(self.attn(attn_in), dim=-1)
        mu = (h * w).sum(dim=-1)
        sg = torch.sqrt((((h - mu.unsqueeze(-1)) ** 2) * w).sum(dim=-1).clamp(min=1e-6))
        emb = self.bn_out(self.fc(self.bn_pool(torch.cat([mu, sg], dim=1))))
        return F.normalize(emb.float(), p=2, dim=-1)


# =============================================================================
# 3. Stage 5 Neural Vocoder (Stage5Lite 3.73M & Teacher 14.35M NSF-HiFiGAN)
# =============================================================================
class _ResBlock1(nn.Module):
    def __init__(self, channels: int, kernel_size: int, dilations: Tuple[int, ...] = (1, 3, 5)) -> None:
        super().__init__()
        self.convs1 = nn.ModuleList()
        self.convs2 = nn.ModuleList()
        for d in dilations:
            pad = (kernel_size * d - d) // 2
            self.convs1.append(weight_norm(nn.Conv1d(channels, channels, kernel_size, stride=1, dilation=d, padding=pad)))
            self.convs2.append(weight_norm(nn.Conv1d(channels, channels, kernel_size, stride=1, dilation=1, padding=(kernel_size - 1) // 2)))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        for c1, c2 in zip(self.convs1, self.convs2):
            xt = c2(F.leaky_relu(c1(F.leaky_relu(x, LRELU_SLOPE)), LRELU_SLOPE))
            x = xt + x
        return x


class _MRFBlock(nn.Module):
    def __init__(
        self,
        channels: int,
        kernel_sizes: Sequence[int] = (3, 7, 11),
        dilations: Sequence[Tuple[int, ...]] = ((1, 3, 5), (1, 3, 5), (1, 3, 5)),
    ) -> None:
        super().__init__()
        self.resblocks = nn.ModuleList([_ResBlock1(channels, k, d) for k, d in zip(kernel_sizes, dilations)])

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        acc = self.resblocks[0](x)
        for rb in self.resblocks[1:]:
            acc = acc + rb(x)
        return acc / float(len(self.resblocks))


class SineGen27(nn.Module):
    def __init__(self, sample_rate: int = SAMPLE_RATE_16K, harmonic_num: int = 7, sine_amp: float = 0.1, noise_std: float = 0.003) -> None:
        super().__init__()
        self.sample_rate = int(sample_rate)
        self.harmonic_num = int(harmonic_num)
        self.dim = self.harmonic_num + 1
        self.sine_amp = float(sine_amp)
        self.noise_std = float(noise_std)
        self.register_buffer("harm_idx", torch.arange(1, self.dim + 1, dtype=torch.float32).view(1, self.dim, 1), persistent=False)

    def forward(self, f0_16k: torch.Tensor) -> Tuple[torch.Tensor, torch.Tensor]:
        sr = float(self.sample_rate)
        freq = f0_16k * self.harm_idx.to(device=f0_16k.device, dtype=f0_16k.dtype)
        nyq_mask = torch.clamp((0.49 * sr - freq) / (0.04 * sr), 0.0, 1.0)
        cum_rad = torch.cumsum((freq / sr).to(torch.float64), dim=-1)
        phase = 2.0 * math.pi * torch.remainder(cum_rad, 1.0)
        sine_waves = torch.sin(phase).float() * self.sine_amp * nyq_mask
        return sine_waves, torch.randn_like(sine_waves) * self.noise_std


class SourceModuleHnNSF(nn.Module):
    def __init__(self, sample_rate: int = SAMPLE_RATE_16K, hop_samples: int = HOP_SAMPLES_16K, harmonic_num: int = 7) -> None:
        super().__init__()
        self.sample_rate = int(sample_rate)
        self.hop_samples = int(hop_samples)
        self.harmonic_num = int(harmonic_num)
        self.dim = self.harmonic_num + 1
        self.l_sin_gen = SineGen27(sample_rate=self.sample_rate, harmonic_num=self.harmonic_num)
        self.voicing_net = nn.Sequential(nn.Conv1d(10, 32, kernel_size=3, padding=1), nn.SiLU(), nn.Conv1d(32, 1, kernel_size=3, padding=1))
        self.l_linear = nn.Linear(self.dim, 1)

    def forward(self, m27_norm: torch.Tensor) -> torch.Tensor:
        f0_norm = m27_norm[..., F0_IDX].float().clamp(-1.0, 1.0)
        pr_norm = m27_norm[..., PR_IDX].float().clamp(-1.0, 1.0)
        f0_hz = torch.exp(0.5 * (f0_norm + 1.0) * (LOG_F0_MAX_M27 - LOG_F0_MIN_M27) + LOG_F0_MIN_M27)
        pr_dpa = 0.5 * (pr_norm + 1.0) * (PR_MAX_M27 - PR_MIN_M27) + PR_MIN_M27
        pr_gate = torch.sigmoid((pr_dpa - 350.0) / 80.0).unsqueeze(1)
        uv_gate = torch.sigmoid(self.voicing_net(m27_norm[..., 17:27].float().transpose(1, 2))) * pr_gate
        f0_16k = F.interpolate(f0_hz.unsqueeze(1), scale_factor=self.hop_samples, mode="linear", align_corners=False)
        uv_16k = F.interpolate(uv_gate, scale_factor=self.hop_samples, mode="linear", align_corners=False)
        pr_16k = F.interpolate(pr_gate, scale_factor=self.hop_samples, mode="linear", align_corners=False)
        sine_waves, noise = self.l_sin_gen(f0_16k)
        merged = self.l_linear((sine_waves * uv_16k + noise * (1.0 - 0.85 * uv_16k) * pr_16k).transpose(1, 2)).transpose(1, 2)
        return torch.tanh(merged)


class GlottisAwareSourceModule(nn.Module):
    def __init__(self, sample_rate: int = SAMPLE_RATE_16K, hop_samples: int = HOP_SAMPLES_16K, harmonic_num: int = 11, sine_amp: float = 0.1) -> None:
        super().__init__()
        self.sample_rate = int(sample_rate)
        self.hop_samples = int(hop_samples)
        self.harmonic_num = int(harmonic_num)
        self.dim = self.harmonic_num + 1
        self.sine_amp = float(sine_amp)
        all_idx = torch.cat([torch.tensor([0.5], dtype=torch.float32), torch.arange(1, self.dim + 1, dtype=torch.float32)]).view(1, self.dim + 1, 1)
        self.register_buffer("all_harm_idx", all_idx, persistent=False)
        self.src_enc = nn.Sequential(nn.Conv1d(10, 48, kernel_size=3, padding=1), nn.SiLU(), nn.Conv1d(48, 48, kernel_size=3, padding=1), nn.SiLU())
        self.harm_head = nn.Conv1d(48, self.dim, kernel_size=1)
        self.sub_head = nn.Conv1d(48, 1, kernel_size=1)
        self.noise_head = nn.Conv1d(48, 2, kernel_size=1)
        self.jit_head = nn.Conv1d(48, 1, kernel_size=1)
        self.shim_head = nn.Conv1d(48, 1, kernel_size=1)

    def forward(self, m27_norm: torch.Tensor) -> torch.Tensor:
        bsz, n_frames, _ = m27_norm.shape
        l_wav = n_frames * self.hop_samples
        device = m27_norm.device
        sr = float(self.sample_rate)

        f0_norm = m27_norm[..., F0_IDX].float().clamp(-1.0, 1.0)
        pr_norm = m27_norm[..., PR_IDX].float().clamp(-1.0, 1.0)
        f0_hz = torch.exp(0.5 * (f0_norm + 1.0) * (LOG_F0_MAX_M27 - LOG_F0_MIN_M27) + LOG_F0_MIN_M27)
        pr_dpa = 0.5 * (pr_norm + 1.0) * (PR_MAX_M27 - PR_MIN_M27) + PR_MIN_M27
        pr_gate = torch.sigmoid((pr_dpa - 350.0) / 80.0).unsqueeze(1)
        fl_01 = (0.5 * (m27_norm[..., 25].float().clamp(-1.0, 1.0) + 1.0)).unsqueeze(1)
        shim_01 = (0.5 * (m27_norm[..., 26].float().clamp(-1.0, 1.0) + 1.0)).unsqueeze(1)

        h = self.src_enc(m27_norm[..., 17:27].float().transpose(1, 2))
        harm_w = F.softplus(self.harm_head(h)) * pr_gate
        sub_w = torch.sigmoid(self.sub_head(h)) * pr_gate
        noise_w = (0.002 + 0.28 * torch.sigmoid(self.noise_head(h))) * pr_gate
        jit_scale = 0.16 * fl_01 * torch.sigmoid(self.jit_head(h)) * pr_gate
        shim_scale = 0.45 * shim_01 * torch.sigmoid(self.shim_head(h)) * pr_gate

        packed = torch.cat([f0_hz.unsqueeze(1), harm_w, sub_w, noise_w, jit_scale, shim_scale], dim=1)
        packed_16k = F.interpolate(packed, size=l_wav, mode="linear", align_corners=False)
        f0_16k, harm_w_16k, sub_w_16k, noise_w_16k, jit_16k, shim_16k = torch.split(packed_16k, [1, self.dim, 1, 2, 1, 1], dim=1)

        rng = torch.Generator(device=device)
        rng.manual_seed(20261122)
        env_rand = torch.randn((bsz, 2, n_frames * 2), device=device, dtype=torch.float32, generator=rng)
        env_16k = F.interpolate(env_rand, size=l_wav, mode="linear", align_corners=False)
        f0_eff = (f0_16k * (1.0 + env_16k[:, 0:1, :] * jit_16k).clamp(0.45, 1.55)).clamp(20.0, 0.45 * sr)
        shim_mod = (1.0 + env_16k[:, 1:2, :] * shim_16k).clamp(0.15, 1.85)

        freq = f0_eff * self.all_harm_idx.to(device=device, dtype=torch.float32)
        nyq_mask = torch.clamp((0.49 * sr - freq) / (0.04 * sr), 0.0, 1.0)
        cum_rad = torch.cumsum((freq / sr).to(torch.float64), dim=-1)
        phase = 2.0 * math.pi * torch.remainder(cum_rad, 1.0)
        sine_all = torch.sin(phase).float() * self.sine_amp * nyq_mask
        har_sig = ((sine_all[:, 1:, :] * harm_w_16k).sum(dim=1, keepdim=True) + sine_all[:, 0:1, :] * sub_w_16k) * shim_mod
        ch_har = torch.tanh(har_sig)

        n_wb = torch.randn((bsz, 1, l_wav), device=device, dtype=torch.float32, generator=rng)
        n_hp = n_wb - 0.85 * F.pad(n_wb[..., :-1], (1, 0))
        ch_noise = torch.tanh(n_wb * noise_w_16k[:, 0:1, :] + n_hp * noise_w_16k[:, 1:2, :])
        return torch.cat([ch_har, ch_noise], dim=1)


class ConditionalHiFiGenerator27(nn.Module):
    """Speaker- and glottis-conditioned NSF-HiFiGAN vocoder (supports both Stage5Lite & Teacher)."""

    def __init__(
        self,
        in_channels: int = 27,
        spk_dim: int = 512,
        cond_dim: int = 128,
        upsample_initial_channel: int = 256,
        upsample_rates: Tuple[int, ...] = (8, 5, 4, 2),
        upsample_kernel_sizes: Tuple[int, ...] = (16, 11, 8, 4),
        resblock_kernel_sizes: Tuple[int, ...] = (3, 7, 11),
        resblock_dilations: Tuple[Tuple[int, ...], ...] = ((1, 3, 5), (1, 3, 5), (1, 3, 5)),
        film_stage_indices: Tuple[int, ...] = (0, 1),
        use_nsf: bool = True,
        harmonic_num: int = 11,
        source_mode: str = "glottis_v3",
        glottis_film_indices: Tuple[int, ...] = (1, 2, 3),
    ) -> None:
        super().__init__()
        self.in_channels = int(in_channels)
        self.spk_dim = int(spk_dim)
        self.cond_dim = int(cond_dim)
        self.upsample_initial_channel = int(upsample_initial_channel)
        self.upsample_rates = tuple(int(r) for r in upsample_rates)
        self.upsample_kernel_sizes = tuple(int(k) for k in upsample_kernel_sizes)
        self.resblock_kernel_sizes = tuple(int(k) for k in resblock_kernel_sizes)
        self.resblock_dilations = tuple(tuple(int(v) for v in d) for d in resblock_dilations)
        self.film_stage_indices = set(int(i) for i in film_stage_indices)
        self.use_nsf = bool(use_nsf)
        self.harmonic_num = int(harmonic_num)
        self.source_mode = str(source_mode)
        self.glottis_film_indices = set(int(i) for i in glottis_film_indices)
        self.hop_samples = int(torch.tensor(self.upsample_rates).prod().item())

        self.spk_proj = nn.Sequential(
            nn.Linear(self.spk_dim, self.cond_dim),
            nn.LayerNorm(self.cond_dim),
            nn.SiLU(),
            nn.Linear(self.cond_dim, self.cond_dim),
        )
        self.conv_pre = weight_norm(nn.Conv1d(self.in_channels, self.upsample_initial_channel, kernel_size=7, padding=3))
        self.cond_fuse = weight_norm(nn.Conv1d(self.upsample_initial_channel + self.cond_dim, self.upsample_initial_channel, kernel_size=1))

        if self.use_nsf:
            if self.source_mode == "glottis_v3":
                self.m_source: Optional[nn.Module] = GlottisAwareSourceModule(sample_rate=SAMPLE_RATE_16K, hop_samples=self.hop_samples, harmonic_num=self.harmonic_num)
                src_ch = 2
            else:
                self.m_source = SourceModuleHnNSF(sample_rate=SAMPLE_RATE_16K, hop_samples=self.hop_samples, harmonic_num=self.harmonic_num)
                src_ch = 1
            self.noise_convs = nn.ModuleList()
        else:
            self.m_source = None
            self.noise_convs = nn.ModuleList()
            src_ch = 0

        if self.glottis_film_indices:
            self.glottis_enc: Optional[nn.Module] = nn.Sequential(
                weight_norm(nn.Conv1d(10, 64, kernel_size=3, padding=1)),
                nn.SiLU(),
                weight_norm(nn.Conv1d(64, 64, kernel_size=3, padding=1)),
                nn.SiLU(),
            )
        else:
            self.glottis_enc = None
        self.glottis_films = nn.ModuleDict()

        self.ups = nn.ModuleList()
        self.mrfs = nn.ModuleList()
        self.films = nn.ModuleDict()
        ch = self.upsample_initial_channel
        for i, (stride, kernel) in enumerate(zip(self.upsample_rates, self.upsample_kernel_sizes)):
            next_ch = ch // 2
            pad = (kernel - stride) // 2
            self.ups.append(weight_norm(nn.ConvTranspose1d(ch, next_ch, kernel_size=kernel, stride=stride, padding=pad)))
            if self.use_nsf:
                rem = 1
                for r in self.upsample_rates[i + 1 :]:
                    rem *= r
                if rem == 1:
                    self.noise_convs.append(weight_norm(nn.Conv1d(src_ch, next_ch, kernel_size=1, stride=1, padding=0)))
                else:
                    self.noise_convs.append(weight_norm(nn.Conv1d(src_ch, next_ch, kernel_size=rem * 2, stride=rem, padding=rem // 2)))
            self.mrfs.append(_MRFBlock(next_ch, self.resblock_kernel_sizes, self.resblock_dilations))
            if i in self.film_stage_indices:
                self.films[str(i)] = nn.Linear(self.cond_dim, next_ch * 2)
            if i in self.glottis_film_indices:
                self.glottis_films[str(i)] = nn.Conv1d(64, next_ch * 2, kernel_size=1)
            ch = next_ch
        self.conv_post = weight_norm(nn.Conv1d(ch, 1, kernel_size=7, padding=3))

    @classmethod
    def from_arch_config(cls, cfg: Optional[Dict[str, Any]]) -> "ConditionalHiFiGenerator27":
        if not cfg:
            return cls()
        return cls(
            in_channels=int(cfg.get("in_channels", 27)),
            spk_dim=int(cfg.get("spk_dim", 512)),
            cond_dim=int(cfg.get("cond_dim", 192)),
            upsample_initial_channel=int(cfg.get("upsample_initial_channel", 512)),
            upsample_rates=tuple(int(x) for x in cfg.get("upsample_rates", (8, 5, 4, 2))),
            upsample_kernel_sizes=tuple(int(x) for x in cfg.get("upsample_kernel_sizes", (16, 11, 8, 4))),
            resblock_kernel_sizes=tuple(int(x) for x in cfg.get("resblock_kernel_sizes", (3, 7, 11))),
            resblock_dilations=tuple(tuple(int(v) for v in d) for d in cfg.get("resblock_dilations", ((1, 3, 5), (1, 3, 5), (1, 3, 5)))),
            film_stage_indices=tuple(int(x) for x in cfg.get("film_stage_indices", (0, 1))),
            use_nsf=bool(cfg.get("use_nsf", True)),
            harmonic_num=int(cfg.get("harmonic_num", 11)),
            source_mode=str(cfg.get("source_mode", "glottis_v3")),
            glottis_film_indices=tuple(int(x) for x in cfg.get("glottis_film_indices", (1, 2, 3))),
        )

    def forward(self, m27_norm: torch.Tensor, spk_emb: torch.Tensor) -> torch.Tensor:
        cond = self.spk_proj(F.normalize(spk_emb.float(), p=2, dim=-1))
        har_source = self.m_source(m27_norm) if self.use_nsf and self.m_source is not None else None
        g_feat = self.glottis_enc(m27_norm[..., 17:27].float().transpose(1, 2)) if self.glottis_enc is not None and self.glottis_films else None
        x = self.conv_pre(m27_norm.float().transpose(1, 2))
        x = self.cond_fuse(torch.cat([x, cond.unsqueeze(-1).expand(-1, -1, x.shape[-1])], dim=1))
        for i, (up, mrf) in enumerate(zip(self.ups, self.mrfs)):
            x = up(F.leaky_relu(x, LRELU_SLOPE))
            if str(i) in self.films:
                gamma, beta = self.films[str(i)](cond).unsqueeze(-1).chunk(2, dim=1)
                x = x * (1.0 + gamma) + beta
            if g_feat is not None and str(i) in self.glottis_films:
                ggb = F.interpolate(self.glottis_films[str(i)](g_feat), size=x.shape[-1], mode="linear", align_corners=False)
                g_gamma, g_beta = ggb.chunk(2, dim=1)
                x = x * (1.0 + g_gamma) + g_beta
            if self.use_nsf and har_source is not None:
                x = x + self.noise_convs[i](har_source)
            x = mrf(x)
        return torch.tanh(self.conv_post(F.leaky_relu(x, LRELU_SLOPE))).squeeze(1)

    def remove_weight_norm(self) -> None:
        for mod in self.modules():
            if hasattr(mod, "parametrizations") and "weight" in mod.parametrizations:
                torch.nn.utils.parametrize.remove_parametrizations(mod, "weight")


# Official unified model class aliases (backward-compatible)
IPA2Tract = KeyframeTractModel27
IPA2TractLite = KeyframeTractModel27
Vox2SpkLite = BrowserLightSpeakerEncoder
Tract2VoxLarge = ConditionalHiFiGenerator27
Tract2VoxLite = ConditionalHiFiGenerator27


# =============================================================================
# 4. Unified FP16 / Per-Channel INT8 / Full Checkpoint Loaders
# =============================================================================
def dequantize_state_dict_int8(packed: Dict[str, Any]) -> Dict[str, torch.Tensor]:
    q_tensors: Dict[str, torch.Tensor] = packed["tensors"]
    scales: Dict[str, torch.Tensor] = packed["scales"]
    out: Dict[str, torch.Tensor] = {}
    for k, v in q_tensors.items():
        if k in scales:
            sc = scales[k].float()
            out[k] = v.float() * sc.reshape([v.shape[0]] + [1] * (v.ndim - 1))
        elif v.is_floating_point():
            out[k] = v.float()
        else:
            out[k] = v
    return out


def load_lite_state_dict(weights_path: Path, map_location: str = "cpu") -> Tuple[Dict[str, torch.Tensor], Dict[str, Any]]:
    raw = torch.load(Path(weights_path), map_location=map_location, weights_only=False)
    if "quantized" in raw:
        return dequantize_state_dict_int8(raw["quantized"]), raw
    if "state_dict" in raw:
        return {k: (v.float() if v.is_floating_point() else v) for k, v in raw["state_dict"].items()}, raw
    if "generator" in raw:
        return {k: (v.float() if v.is_floating_point() else v) for k, v in raw["generator"].items()}, raw
    if "model" in raw:
        return {k: (v.float() if v.is_floating_point() else v) for k, v in raw["model"].items()}, raw
    raise ValueError(f"Unsupported weight schema in {weights_path}")


def load_kf2tract_model(weights_path: Path, device: str = "cpu") -> Tuple[KeyframeTractModel27, Dict[str, Any]]:
    sd, raw = load_lite_state_dict(weights_path, map_location=device)
    cfg = raw.get("config") or {}
    model = KeyframeTractModel27(
        cond_dim=int(cfg.get("cond_dim", KF_COND_DIM)),
        out_dim=int(cfg.get("out_dim", KF_OUT_DIM)),
        hidden_dim=int(cfg.get("hidden_dim", 192)),
        num_layers=int(cfg.get("num_layers", 4)),
        max_residual=float(cfg.get("max_residual", 0.85)),
    ).to(device)
    model.load_state_dict(sd)
    model.eval()
    meta = dict(raw.get("meta") or {})
    meta.setdefault("step", raw.get("step", "lite"))
    meta["schema"] = raw.get("schema", "checkpoint")
    return model, meta


def load_speaker_encoder(weights_path: Path, device: str = "cpu") -> Tuple[BrowserLightSpeakerEncoder, Dict[str, Any]]:
    sd, raw = load_lite_state_dict(weights_path, map_location=device)
    cfg = raw.get("config") or raw.get("arch_config") or {}
    enc = BrowserLightSpeakerEncoder.from_arch_config(cfg).to(device)
    enc.load_state_dict(sd)
    enc.eval()
    meta = dict(raw.get("meta") or {})
    meta["schema"] = raw.get("schema", "checkpoint")
    return enc, meta


def load_neural_vocoder(weights_path: Path, device: str = "cpu") -> Tuple[ConditionalHiFiGenerator27, Dict[str, Any]]:
    sd, raw = load_lite_state_dict(weights_path, map_location=device)
    cfg = raw.get("config") or raw.get("generator_config") or raw.get("gen_kwargs") or raw.get("arch_config") or {}
    meta = dict(raw.get("meta") or {})
    gen = ConditionalHiFiGenerator27.from_arch_config(cfg).to(device)
    wn_removed = bool(meta.get("weight_norm_removed", False)) or (
        "conv_pre.weight" in sd and "conv_pre.parametrizations.weight.original0" not in sd
    )
    if wn_removed:
        gen.remove_weight_norm()
    gen.load_state_dict(sd, strict=True)
    gen.eval()
    meta.setdefault("step", raw.get("step", "lite"))
    meta.setdefault("official_name", raw.get("official_name", "Tract2Vox-Lite"))
    meta["schema"] = raw.get("schema", "checkpoint")
    meta["weight_norm_removed"] = wn_removed
    return gen, meta


__all__ = [
    "BrowserLightSpeakerEncoder",
    "ConditionalHiFiGenerator27",
    "ConformerBlock",
    "IPA2Tract",
    "IPA2TractLite",
    "KeyframeTractModel27",
    "Tract2VoxLarge",
    "Tract2VoxLite",
    "Vox2SpkLite",
    "load_kf2tract_model",
    "load_lite_state_dict",
    "load_neural_vocoder",
    "load_speaker_encoder",
]
