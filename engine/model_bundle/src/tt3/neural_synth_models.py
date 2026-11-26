"""Stage 5 neural synthesis models: FrozenSpeakerEncoder, ConditionalHiFiGenerator27,
MultiPeriodDiscriminator, MultiResolutionSTFTDiscriminator, and MultiScaleMelLoss.
"""
from __future__ import annotations

import math
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.nn.utils.parametrizations import weight_norm
from transformers import WavLMForXVector

from .constants import HF_CACHE_DIR, SAMPLE_RATE_16K, WAVLM_HOP_SAMPLES
from .distill_models import build_mel_filterbank
from .m27_contract import (
    F0_IDX,
    LOG_F0_MAX_M27,
    LOG_F0_MIN_M27,
    PR_IDX,
    PR_MAX_M27,
    PR_MIN_M27,
)
from .models import normalize_waveform_for_wavlm

LRELU_SLOPE = 0.1


def _init_weights(m: nn.Module, mean: float = 0.0, std: float = 0.01) -> None:
    if isinstance(m, (nn.Conv1d, nn.Conv2d, nn.ConvTranspose1d)):
        nn.init.normal_(m.weight, mean, std)
        if m.bias is not None:
            nn.init.zeros_(m.bias)


class FrozenSpeakerEncoder(nn.Module):
    """Frozen pretrained WavLM-base-plus-sv X-Vector encoder yielding L2-normalized 512-d speaker embeddings."""

    def __init__(
        self,
        model_id: str = "microsoft/wavlm-base-plus-sv",
        cache_dir: Path = HF_CACHE_DIR,
    ) -> None:
        super().__init__()
        cache_dir = Path(cache_dir)
        cache_dir.mkdir(parents=True, exist_ok=True)
        try:
            self.model = WavLMForXVector.from_pretrained(
                model_id,
                cache_dir=str(cache_dir),
                local_files_only=True,
            )
        except Exception:
            self.model = WavLMForXVector.from_pretrained(
                model_id,
                cache_dir=str(cache_dir),
                local_files_only=False,
            )
        for p in self.model.parameters():
            p.requires_grad_(False)
        self.model.eval()
        self.emb_dim = int(self.model.config.xvector_output_dim)

    def train(self, mode: bool = True):
        super().train(False)
        self.model.eval()
        return self

    def forward(
        self,
        wav_16k: torch.Tensor,
        valid_samples: Optional[torch.Tensor] = None,
        *,
        allow_grad: bool = False,
        use_bf16: bool = True,
    ) -> torch.Tensor:
        """Compute L2-normalized (B, 512) float32 speaker embeddings from 16 kHz waveforms."""
        normed = normalize_waveform_for_wavlm(wav_16k.float(), valid_samples)
        attn_mask = None
        if valid_samples is not None:
            idx = torch.arange(normed.shape[1], device=normed.device).unsqueeze(0)
            attn_mask = (idx < valid_samples.unsqueeze(1)).long()
        amp_enabled = bool(use_bf16 and wav_16k.is_cuda)
        ctx = torch.enable_grad() if allow_grad else torch.no_grad()
        with ctx:
            with torch.amp.autocast("cuda", dtype=torch.bfloat16, enabled=amp_enabled):
                out = self.model(input_values=normed, attention_mask=attn_mask)
                emb = out.embeddings
        return F.normalize(emb.float(), p=2, dim=-1)


class _ResBlock1(nn.Module):
    """HiFi-GAN Type-1 Multi-Receptive Field residual block."""

    def __init__(
        self,
        channels: int,
        kernel_size: int,
        dilations: Tuple[int, ...] = (1, 3, 5),
    ) -> None:
        super().__init__()
        self.convs1 = nn.ModuleList()
        self.convs2 = nn.ModuleList()
        for d in dilations:
            pad = (kernel_size * d - d) // 2
            self.convs1.append(
                weight_norm(nn.Conv1d(channels, channels, kernel_size, stride=1, dilation=d, padding=pad))
            )
            self.convs2.append(
                weight_norm(nn.Conv1d(channels, channels, kernel_size, stride=1, dilation=1, padding=(kernel_size - 1) // 2))
            )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        for c1, c2 in zip(self.convs1, self.convs2):
            xt = F.leaky_relu(x, LRELU_SLOPE)
            xt = c1(xt)
            xt = F.leaky_relu(xt, LRELU_SLOPE)
            xt = c2(xt)
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
        self.resblocks = nn.ModuleList(
            [_ResBlock1(channels, k, d) for k, d in zip(kernel_sizes, dilations)]
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        acc = self.resblocks[0](x)
        for rb in self.resblocks[1:]:
            acc = acc + rb(x)
        return acc / float(len(self.resblocks))


class SineGen27(nn.Module):
    """Continuous-phase multi-harmonic sine generator driven by 16 kHz upsampled F0."""

    def __init__(
        self,
        sample_rate: int = SAMPLE_RATE_16K,
        harmonic_num: int = 7,
        sine_amp: float = 0.1,
        noise_std: float = 0.003,
    ) -> None:
        super().__init__()
        self.sample_rate = int(sample_rate)
        self.harmonic_num = int(harmonic_num)
        self.dim = self.harmonic_num + 1
        self.sine_amp = float(sine_amp)
        self.noise_std = float(noise_std)
        self.register_buffer(
            "harm_idx",
            torch.arange(1, self.dim + 1, dtype=torch.float32).view(1, self.dim, 1),
            persistent=False,
        )

    def forward(self, f0_16k: torch.Tensor) -> Tuple[torch.Tensor, torch.Tensor]:
        """Generate `(sine_waves, noise)` of shape `(B, dim, L)` from `f0_16k (B, 1, L)`."""
        sr = float(self.sample_rate)
        freq = f0_16k * self.harm_idx.to(device=f0_16k.device, dtype=f0_16k.dtype)
        nyq_mask = torch.clamp((0.49 * sr - freq) / (0.04 * sr), 0.0, 1.0)
        rad_step = (freq / sr).to(torch.float64)
        cum_rad = torch.cumsum(rad_step, dim=-1)
        if self.training and self.harmonic_num > 0:
            rand_ini = torch.rand(
                (f0_16k.shape[0], self.harmonic_num, 1),
                device=f0_16k.device,
                dtype=torch.float64,
            )
            cum_rad = cum_rad.clone()
            cum_rad[:, 1:, :] = cum_rad[:, 1:, :] + rand_ini
        phase = 2.0 * math.pi * torch.remainder(cum_rad, 1.0)
        sine_waves = torch.sin(phase).float() * self.sine_amp * nyq_mask
        noise = torch.randn_like(sine_waves) * self.noise_std
        return sine_waves, noise


class SourceModuleHnNSF(nn.Module):
    """Harmonic-plus-noise NSF source driven by M27 physical F0, PR, and glottis trajectory."""

    def __init__(
        self,
        sample_rate: int = SAMPLE_RATE_16K,
        hop_samples: int = WAVLM_HOP_SAMPLES,
        harmonic_num: int = 7,
        sine_amp: float = 0.1,
        noise_std: float = 0.003,
    ) -> None:
        super().__init__()
        self.sample_rate = int(sample_rate)
        self.hop_samples = int(hop_samples)
        self.harmonic_num = int(harmonic_num)
        self.dim = self.harmonic_num + 1
        self.l_sin_gen = SineGen27(
            sample_rate=self.sample_rate,
            harmonic_num=self.harmonic_num,
            sine_amp=sine_amp,
            noise_std=noise_std,
        )
        self.voicing_net = nn.Sequential(
            nn.Conv1d(10, 32, kernel_size=3, padding=1),
            nn.SiLU(),
            nn.Conv1d(32, 1, kernel_size=3, padding=1),
        )
        self.l_linear = nn.Linear(self.dim, 1)
        self.reset_source_init()

    def reset_source_init(self) -> None:
        with torch.no_grad():
            self.l_linear.weight.fill_(1.0 / float(self.dim))
            self.l_linear.bias.zero_()
            nn.init.constant_(self.voicing_net[-1].bias, 0.5)

    def forward(self, m27_norm: torch.Tensor) -> torch.Tensor:
        """Compute continuous-phase `(B, 1, T * hop_samples)` harmonic+noise excitation."""
        f0_norm = m27_norm[..., F0_IDX].float().clamp(-1.0, 1.0)
        pr_norm = m27_norm[..., PR_IDX].float().clamp(-1.0, 1.0)
        f0_hz = torch.exp(
            0.5 * (f0_norm + 1.0) * (LOG_F0_MAX_M27 - LOG_F0_MIN_M27) + LOG_F0_MIN_M27
        )
        pr_dpa = 0.5 * (pr_norm + 1.0) * (PR_MAX_M27 - PR_MIN_M27) + PR_MIN_M27
        pr_gate = torch.sigmoid((pr_dpa - 350.0) / 80.0).unsqueeze(1)  # (B, 1, T)

        src10 = m27_norm[..., 17:27].float().transpose(1, 2)
        uv_gate = torch.sigmoid(self.voicing_net(src10)) * pr_gate  # (B, 1, T)

        f0_16k = F.interpolate(
            f0_hz.unsqueeze(1), scale_factor=self.hop_samples, mode="linear", align_corners=False
        )
        uv_16k = F.interpolate(
            uv_gate, scale_factor=self.hop_samples, mode="linear", align_corners=False
        )
        pr_16k = F.interpolate(
            pr_gate, scale_factor=self.hop_samples, mode="linear", align_corners=False
        )

        sine_waves, noise = self.l_sin_gen(f0_16k)
        voiced_part = sine_waves * uv_16k
        noise_part = noise * (1.0 - 0.85 * uv_16k) * pr_16k
        merged = self.l_linear((voiced_part + noise_part).transpose(1, 2)).transpose(1, 2)
        return torch.tanh(merged)


class GlottisAwareSourceModule(nn.Module):
    """Phonation-aware 2-channel NSF source driven by M27 physical F0, PR, and glottis trajectory.

    Channel 0: Dynamic harmonic comb (k = 1..12 weighted by spectral-tilt net) + creaky
               0.5*F0 subharmonic + FL cycle-to-cycle F0 flutter + SHIM amplitude shimmer.
    Channel 1: Independent 2-band (wideband + glottal-chink high-pass) breathy/aspiration noise.
    """

    def __init__(
        self,
        sample_rate: int = SAMPLE_RATE_16K,
        hop_samples: int = WAVLM_HOP_SAMPLES,
        harmonic_num: int = 11,
        sine_amp: float = 0.1,
    ) -> None:
        super().__init__()
        self.sample_rate = int(sample_rate)
        self.hop_samples = int(hop_samples)
        self.harmonic_num = int(harmonic_num)
        self.dim = self.harmonic_num + 1  # 12 harmonics (k=1..12)
        self.sine_amp = float(sine_amp)

        # Indices [0.5, 1, 2, ..., dim] for subharmonic + harmonic synthesis
        all_idx = torch.cat(
            [torch.tensor([0.5], dtype=torch.float32), torch.arange(1, self.dim + 1, dtype=torch.float32)]
        ).view(1, self.dim + 1, 1)
        self.register_buffer("all_harm_idx", all_idx, persistent=False)

        self.src_enc = nn.Sequential(
            nn.Conv1d(10, 48, kernel_size=3, padding=1),
            nn.SiLU(),
            nn.Conv1d(48, 48, kernel_size=3, padding=1),
            nn.SiLU(),
        )
        self.harm_head = nn.Conv1d(48, self.dim, kernel_size=1)
        self.sub_head = nn.Conv1d(48, 1, kernel_size=1)
        self.noise_head = nn.Conv1d(48, 2, kernel_size=1)
        self.jit_head = nn.Conv1d(48, 1, kernel_size=1)
        self.shim_head = nn.Conv1d(48, 1, kernel_size=1)
        self.reset_source_init()

    def reset_source_init(self) -> None:
        with torch.no_grad():
            target = 0.25 / torch.arange(1, self.dim + 1, dtype=torch.float32, device=self.harm_head.bias.device)
            inv_sp = torch.log(torch.expm1(target).clamp(min=1e-4))
            self.harm_head.bias.copy_(inv_sp)
            self.sub_head.bias.fill_(-2.5)
            self.noise_head.bias.fill_(-2.5)
            self.jit_head.bias.zero_()
            self.shim_head.bias.zero_()

    def forward(self, m27_norm: torch.Tensor) -> torch.Tensor:
        """Return `(B, 2, T * hop_samples)` continuous glottis-modulated excitation [harmonic, noise]."""
        bsz, n_frames, _ = m27_norm.shape
        l_wav = n_frames * self.hop_samples
        device = m27_norm.device
        sr = float(self.sample_rate)

        f0_norm = m27_norm[..., F0_IDX].float().clamp(-1.0, 1.0)
        pr_norm = m27_norm[..., PR_IDX].float().clamp(-1.0, 1.0)
        f0_hz = torch.exp(
            0.5 * (f0_norm + 1.0) * (LOG_F0_MAX_M27 - LOG_F0_MIN_M27) + LOG_F0_MIN_M27
        )
        pr_dpa = 0.5 * (pr_norm + 1.0) * (PR_MAX_M27 - PR_MIN_M27) + PR_MIN_M27
        pr_gate = torch.sigmoid((pr_dpa - 350.0) / 80.0).unsqueeze(1)  # (B, 1, T)

        fl_01 = (0.5 * (m27_norm[..., 25].float().clamp(-1.0, 1.0) + 1.0)).unsqueeze(1)
        shim_01 = (0.5 * (m27_norm[..., 26].float().clamp(-1.0, 1.0) + 1.0)).unsqueeze(1)

        src10 = m27_norm[..., 17:27].float().transpose(1, 2)
        h = self.src_enc(src10)
        harm_w = F.softplus(self.harm_head(h)) * pr_gate                        # (B, 12, T)
        sub_w = torch.sigmoid(self.sub_head(h)) * pr_gate                       # (B, 1, T)
        noise_w = (0.002 + 0.28 * torch.sigmoid(self.noise_head(h))) * pr_gate  # (B, 2, T)
        jit_scale = 0.16 * fl_01 * torch.sigmoid(self.jit_head(h)) * pr_gate    # (B, 1, T)
        shim_scale = 0.45 * shim_01 * torch.sigmoid(self.shim_head(h)) * pr_gate  # (B, 1, T)

        packed = torch.cat([f0_hz.unsqueeze(1), harm_w, sub_w, noise_w, jit_scale, shim_scale], dim=1)
        packed_16k = F.interpolate(packed, size=l_wav, mode="linear", align_corners=False)
        f0_16k, harm_w_16k, sub_w_16k, noise_w_16k, jit_16k, shim_16k = torch.split(
            packed_16k, [1, self.dim, 1, 2, 1, 1], dim=1
        )

        rng: Optional[torch.Generator] = None
        if not self.training:
            rng = torch.Generator(device=device)
            rng.manual_seed(20261122)

        # 100 Hz bandlimited cycle-to-cycle micro-perturbation for creaky flutter & shimmer
        env_rand = torch.randn((bsz, 2, n_frames * 2), device=device, dtype=torch.float32, generator=rng)
        env_16k = F.interpolate(env_rand, size=l_wav, mode="linear", align_corners=False)
        f0_eff = (f0_16k * (1.0 + env_16k[:, 0:1, :] * jit_16k).clamp(0.45, 1.55)).clamp(20.0, 0.45 * sr)
        shim_mod = (1.0 + env_16k[:, 1:2, :] * shim_16k).clamp(0.15, 1.85)

        idx_buf = self.all_harm_idx.to(device=device, dtype=torch.float32)
        freq = f0_eff * idx_buf  # (B, 1 + dim, L)
        nyq_mask = torch.clamp((0.49 * sr - freq) / (0.04 * sr), 0.0, 1.0)
        cum_rad = torch.cumsum((freq / sr).to(torch.float64), dim=-1)
        if self.training and self.harmonic_num > 0:
            rand_ini = torch.rand(
                (bsz, self.harmonic_num, 1),
                device=device,
                dtype=torch.float64,
            )
            cum_rad = cum_rad.clone()
            cum_rad[:, 2:, :] = cum_rad[:, 2:, :] + rand_ini
        phase = 2.0 * math.pi * torch.remainder(cum_rad, 1.0)
        sine_all = torch.sin(phase).float() * self.sine_amp * nyq_mask
        sine_sub = sine_all[:, 0:1, :]
        sine_harm = sine_all[:, 1:, :]

        har_sig = ((sine_harm * harm_w_16k).sum(dim=1, keepdim=True) + sine_sub * sub_w_16k) * shim_mod
        ch_har = torch.tanh(har_sig)

        n_wb = torch.randn((bsz, 1, l_wav), device=device, dtype=torch.float32, generator=rng)
        n_hp = n_wb - 0.85 * F.pad(n_wb[..., :-1], (1, 0))
        ch_noise = torch.tanh(n_wb * noise_w_16k[:, 0:1, :] + n_hp * noise_w_16k[:, 1:2, :])
        return torch.cat([ch_har, ch_noise], dim=1)


class ConditionalHiFiGenerator27(nn.Module):
    """Speaker- and glottis-conditioned NSF-HiFiGAN vocoder mapping 50 Hz M27 + spk_emb -> 16 kHz audio."""

    def __init__(
        self,
        in_channels: int = 27,
        spk_dim: int = 512,
        cond_dim: int = 192,
        upsample_initial_channel: int = 512,
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

        assert len(self.upsample_rates) == len(self.upsample_kernel_sizes)
        for s_rate, k_sz in zip(self.upsample_rates, self.upsample_kernel_sizes):
            assert (k_sz - s_rate) % 2 == 0, f"Kernel {k_sz} and stride {s_rate} must match parity"

        self.hop_samples = int(torch.tensor(self.upsample_rates).prod().item())  # 320 for 50 Hz -> 16 kHz

        self.spk_proj = nn.Sequential(
            nn.Linear(self.spk_dim, self.cond_dim),
            nn.LayerNorm(self.cond_dim),
            nn.SiLU(),
            nn.Linear(self.cond_dim, self.cond_dim),
        )
        self.conv_pre = weight_norm(
            nn.Conv1d(self.in_channels, self.upsample_initial_channel, kernel_size=7, padding=3)
        )
        self.cond_fuse = weight_norm(
            nn.Conv1d(self.upsample_initial_channel + self.cond_dim, self.upsample_initial_channel, kernel_size=1)
        )

        if self.use_nsf:
            if self.source_mode == "glottis_v3":
                self.m_source: Optional[nn.Module] = GlottisAwareSourceModule(
                    sample_rate=SAMPLE_RATE_16K,
                    hop_samples=self.hop_samples,
                    harmonic_num=self.harmonic_num,
                )
                src_ch = 2
            else:
                self.m_source = SourceModuleHnNSF(
                    sample_rate=SAMPLE_RATE_16K,
                    hop_samples=self.hop_samples,
                    harmonic_num=self.harmonic_num,
                )
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
            self.glottis_films = nn.ModuleDict()
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
            self.ups.append(
                weight_norm(nn.ConvTranspose1d(ch, next_ch, kernel_size=kernel, stride=stride, padding=pad))
            )
            if self.use_nsf:
                rem = 1
                for r in self.upsample_rates[i + 1 :]:
                    rem *= r
                if rem == 1:
                    self.noise_convs.append(weight_norm(nn.Conv1d(src_ch, next_ch, kernel_size=1, stride=1, padding=0)))
                else:
                    assert rem % 2 == 0, f"Remaining upsample factor {rem} must be even for exact NSF alignment"
                    self.noise_convs.append(
                        weight_norm(nn.Conv1d(src_ch, next_ch, kernel_size=rem * 2, stride=rem, padding=rem // 2))
                    )
            self.mrfs.append(_MRFBlock(next_ch, self.resblock_kernel_sizes, self.resblock_dilations))
            if i in self.film_stage_indices:
                proj = nn.Linear(self.cond_dim, next_ch * 2)
                nn.init.zeros_(proj.weight)
                nn.init.zeros_(proj.bias)
                self.films[str(i)] = proj
            if i in self.glottis_film_indices:
                gproj = nn.Conv1d(64, next_ch * 2, kernel_size=1)
                nn.init.zeros_(gproj.weight)
                nn.init.zeros_(gproj.bias)
                self.glottis_films[str(i)] = gproj
            ch = next_ch

        self.conv_post = weight_norm(nn.Conv1d(ch, 1, kernel_size=7, padding=3))
        self.apply(_init_weights)
        # Keep FiLM layers near identity at init and restore source initialization after global _init_weights
        for proj in self.films.values():
            nn.init.zeros_(proj.weight)
            nn.init.zeros_(proj.bias)
        for gproj in self.glottis_films.values():
            nn.init.zeros_(gproj.weight)
            nn.init.zeros_(gproj.bias)
        if self.m_source is not None:
            self.m_source.reset_source_init()

    @property
    def arch_name(self) -> str:
        if not self.use_nsf:
            return "hifi_v1"
        if self.source_mode == "glottis_v3":
            return "nsf_glottis_v3"
        return "nsf_hifi_v2"

    def get_arch_config(self) -> Dict[str, Any]:
        return {
            "in_channels": self.in_channels,
            "spk_dim": self.spk_dim,
            "cond_dim": self.cond_dim,
            "upsample_initial_channel": self.upsample_initial_channel,
            "upsample_rates": list(self.upsample_rates),
            "upsample_kernel_sizes": list(self.upsample_kernel_sizes),
            "resblock_kernel_sizes": list(self.resblock_kernel_sizes),
            "resblock_dilations": [list(d) for d in self.resblock_dilations],
            "film_stage_indices": sorted(self.film_stage_indices),
            "use_nsf": self.use_nsf,
            "harmonic_num": self.harmonic_num,
            "source_mode": self.source_mode,
            "glottis_film_indices": sorted(self.glottis_film_indices),
        }

    @classmethod
    def from_arch_config(cls, cfg: Optional[Dict[str, Any]]) -> "ConditionalHiFiGenerator27":
        if not cfg:
            return cls(
                use_nsf=False,
                source_mode="basic_v2",
                upsample_rates=(10, 8, 2, 2),
                upsample_kernel_sizes=(20, 16, 4, 4),
                film_stage_indices=(0, 1),
                glottis_film_indices=(),
            )
        if "source_mode" not in cfg:
            return cls(
                in_channels=int(cfg.get("in_channels", 27)),
                spk_dim=int(cfg.get("spk_dim", 512)),
                cond_dim=int(cfg.get("cond_dim", 192)),
                upsample_initial_channel=int(cfg.get("upsample_initial_channel", 512)),
                upsample_rates=tuple(int(x) for x in cfg["upsample_rates"]),
                upsample_kernel_sizes=tuple(int(x) for x in cfg["upsample_kernel_sizes"]),
                resblock_kernel_sizes=tuple(int(x) for x in cfg.get("resblock_kernel_sizes", (3, 7, 11))),
                resblock_dilations=tuple(
                    tuple(int(v) for v in d) for d in cfg.get("resblock_dilations", ((1, 3, 5), (1, 3, 5), (1, 3, 5)))
                ),
                film_stage_indices=tuple(int(x) for x in cfg.get("film_stage_indices", (0, 1, 2))),
                use_nsf=bool(cfg.get("use_nsf", True)),
                harmonic_num=int(cfg.get("harmonic_num", 7)),
                source_mode="basic_v2",
                glottis_film_indices=(),
            )
        return cls(
            in_channels=int(cfg.get("in_channels", 27)),
            spk_dim=int(cfg.get("spk_dim", 512)),
            cond_dim=int(cfg.get("cond_dim", 192)),
            upsample_initial_channel=int(cfg.get("upsample_initial_channel", 512)),
            upsample_rates=tuple(int(x) for x in cfg["upsample_rates"]),
            upsample_kernel_sizes=tuple(int(x) for x in cfg["upsample_kernel_sizes"]),
            resblock_kernel_sizes=tuple(int(x) for x in cfg.get("resblock_kernel_sizes", (3, 7, 11))),
            resblock_dilations=tuple(
                tuple(int(v) for v in d) for d in cfg.get("resblock_dilations", ((1, 3, 5), (1, 3, 5), (1, 3, 5)))
            ),
            film_stage_indices=tuple(int(x) for x in cfg.get("film_stage_indices", (0, 1))),
            use_nsf=bool(cfg.get("use_nsf", True)),
            harmonic_num=int(cfg.get("harmonic_num", 11)),
            source_mode=str(cfg.get("source_mode", "glottis_v3")),
            glottis_film_indices=tuple(int(x) for x in cfg.get("glottis_film_indices", (1, 2, 3))),
        )

    def forward(self, m27_norm: torch.Tensor, spk_emb: torch.Tensor) -> torch.Tensor:
        """Synthesize 16 kHz mono waveform `(B, T * 320)` from `m27_norm (B, T, 27)` and `spk_emb (B, 512)`."""
        cond = self.spk_proj(F.normalize(spk_emb.float(), p=2, dim=-1))  # (B, cond_dim)
        har_source = self.m_source(m27_norm) if self.use_nsf and self.m_source is not None else None
        g_feat = (
            self.glottis_enc(m27_norm[..., 17:27].float().transpose(1, 2))
            if self.glottis_enc is not None and self.glottis_films
            else None
        )
        x = self.conv_pre(m27_norm.float().transpose(1, 2))  # (B, 512, T)
        cond_seq = cond.unsqueeze(-1).expand(-1, -1, x.shape[-1])
        x = self.cond_fuse(torch.cat([x, cond_seq], dim=1))

        for i, (up, mrf) in enumerate(zip(self.ups, self.mrfs)):
            x = F.leaky_relu(x, LRELU_SLOPE)
            x = up(x)
            if str(i) in self.films:
                gb = self.films[str(i)](cond).unsqueeze(-1)
                gamma, beta = gb.chunk(2, dim=1)
                x = x * (1.0 + gamma) + beta
            if g_feat is not None and str(i) in self.glottis_films:
                ggb = self.glottis_films[str(i)](g_feat)
                ggb = F.interpolate(ggb, size=x.shape[-1], mode="linear", align_corners=False)
                g_gamma, g_beta = ggb.chunk(2, dim=1)
                x = x * (1.0 + g_gamma) + g_beta
            if self.use_nsf and har_source is not None:
                x = x + self.noise_convs[i](har_source)
            x = mrf(x)

        x = F.leaky_relu(x, LRELU_SLOPE)
        x = torch.tanh(self.conv_post(x))
        return x.squeeze(1)

    def remove_weight_norm(self) -> None:
        for mod in self.modules():
            if hasattr(mod, "parametrizations") and "weight" in mod.parametrizations:
                torch.nn.utils.parametrize.remove_parametrizations(mod, "weight")


class _PeriodDiscriminator(nn.Module):
    def __init__(self, period: int) -> None:
        super().__init__()
        self.period = int(period)
        chs = [(1, 32, 3), (32, 128, 3), (128, 256, 3), (256, 512, 3), (512, 1024, 1)]
        self.convs = nn.ModuleList(
            [
                weight_norm(nn.Conv2d(ic, oc, kernel_size=(5, 1), stride=(st, 1), padding=(2, 0)))
                for ic, oc, st in chs
            ]
        )
        self.conv_post = weight_norm(nn.Conv2d(1024, 1, kernel_size=(3, 1), padding=(1, 0)))

    def forward(self, y: torch.Tensor) -> Tuple[torch.Tensor, List[torch.Tensor]]:
        # y: (B, 1, L)
        fmap: List[torch.Tensor] = []
        bsz, ch, t = y.shape
        if t % self.period != 0:
            n_pad = self.period - (t % self.period)
            y = F.pad(y, (0, n_pad), mode="reflect" if t > n_pad else "constant")
            t = t + n_pad
        x = y.view(bsz, ch, t // self.period, self.period)
        for conv in self.convs:
            x = F.leaky_relu(conv(x), LRELU_SLOPE)
            fmap.append(x)
        x = self.conv_post(x)
        fmap.append(x)
        return x.flatten(1), fmap


class MultiPeriodDiscriminator(nn.Module):
    def __init__(self, periods: Tuple[int, ...] = (2, 3, 5, 7, 11)) -> None:
        super().__init__()
        self.discriminators = nn.ModuleList([_PeriodDiscriminator(p) for p in periods])

    def forward(
        self,
        y_real: torch.Tensor,
        y_fake: torch.Tensor,
    ) -> Tuple[List[torch.Tensor], List[torch.Tensor], List[List[torch.Tensor]], List[List[torch.Tensor]]]:
        r_in = y_real.unsqueeze(1)
        f_in = y_fake.unsqueeze(1)
        r_outs, f_outs, r_fmaps, f_fmaps = [], [], [], []
        for d in self.discriminators:
            ro, rf = d(r_in)
            fo, ff = d(f_in)
            r_outs.append(ro)
            f_outs.append(fo)
            r_fmaps.append(rf)
            f_fmaps.append(ff)
        return r_outs, f_outs, r_fmaps, f_fmaps


class _SpecDiscriminator(nn.Module):
    def __init__(self, n_fft: int, hop_length: int, win_length: int) -> None:
        super().__init__()
        self.n_fft = int(n_fft)
        self.hop_length = int(hop_length)
        self.win_length = int(win_length)
        self.register_buffer("window", torch.hann_window(self.win_length), persistent=True)
        self.convs = nn.ModuleList(
            [
                weight_norm(nn.Conv2d(1, 32, kernel_size=(3, 9), stride=(1, 2), padding=(1, 4))),
                weight_norm(nn.Conv2d(32, 64, kernel_size=(3, 9), stride=(2, 2), padding=(1, 4))),
                weight_norm(nn.Conv2d(64, 128, kernel_size=(3, 9), stride=(2, 2), padding=(1, 4))),
                weight_norm(nn.Conv2d(128, 256, kernel_size=(3, 9), stride=(2, 2), padding=(1, 4))),
                weight_norm(nn.Conv2d(256, 256, kernel_size=(3, 3), stride=(1, 1), padding=(1, 1))),
            ]
        )
        self.conv_post = weight_norm(nn.Conv2d(256, 1, kernel_size=(3, 3), padding=(1, 1)))

    def _log_mag(self, y: torch.Tensor) -> torch.Tensor:
        spec = torch.stft(
            y.float(),
            n_fft=self.n_fft,
            hop_length=self.hop_length,
            win_length=self.win_length,
            window=self.window,
            center=True,
            return_complex=True,
        )
        mag = torch.sqrt(spec.real.square() + spec.imag.square() + 1e-7)
        return torch.log(mag.clamp(min=1e-5)).transpose(1, 2).unsqueeze(1)  # (B, 1, T_spec, F)

    def forward(self, y: torch.Tensor) -> Tuple[torch.Tensor, List[torch.Tensor]]:
        x = self._log_mag(y)
        fmap: List[torch.Tensor] = []
        for conv in self.convs:
            x = F.leaky_relu(conv(x), LRELU_SLOPE)
            fmap.append(x)
        x = self.conv_post(x)
        fmap.append(x)
        return x.flatten(1), fmap


class MultiResolutionSTFTDiscriminator(nn.Module):
    def __init__(
        self,
        resolutions: Tuple[Tuple[int, int, int], ...] = (
            (512, 128, 512),
            (1024, 256, 1024),
            (2048, 512, 2048),
        ),
    ) -> None:
        super().__init__()
        self.discriminators = nn.ModuleList(
            [_SpecDiscriminator(nf, hop, win) for nf, hop, win in resolutions]
        )

    def forward(
        self,
        y_real: torch.Tensor,
        y_fake: torch.Tensor,
    ) -> Tuple[List[torch.Tensor], List[torch.Tensor], List[List[torch.Tensor]], List[List[torch.Tensor]]]:
        r_outs, f_outs, r_fmaps, f_fmaps = [], [], [], []
        for d in self.discriminators:
            ro, rf = d(y_real)
            fo, ff = d(y_fake)
            r_outs.append(ro)
            f_outs.append(fo)
            r_fmaps.append(rf)
            f_fmaps.append(ff)
        return r_outs, f_outs, r_fmaps, f_fmaps


class MultiScaleMelLoss(nn.Module):
    """Multi-resolution Slaney log-Mel L1 reconstruction loss (exact 16 kHz speech acoustics)."""

    def __init__(
        self,
        sr: int = SAMPLE_RATE_16K,
        specs: Tuple[Tuple[int, int, int, int], ...] = (
            (512, 128, 512, 40),
            (1024, 256, 1024, 80),
            (2048, 512, 2048, 128),
        ),
    ) -> None:
        super().__init__()
        self.specs = tuple(specs)
        for i, (n_fft, _, win_len, n_mels) in enumerate(self.specs):
            fb = build_mel_filterbank(sr=sr, n_fft=n_fft, n_mels=n_mels, f_min=40.0, f_max=7600.0)
            self.register_buffer(f"fb_{i}", torch.from_numpy(fb), persistent=True)
            self.register_buffer(f"win_{i}", torch.hann_window(win_len), persistent=True)

    def _log_mel(self, y: torch.Tensor, idx: int) -> torch.Tensor:
        n_fft, hop_len, win_len, _ = self.specs[idx]
        fb = getattr(self, f"fb_{idx}")
        win = getattr(self, f"win_{idx}")
        spec = torch.stft(
            y.float(),
            n_fft=n_fft,
            hop_length=hop_len,
            win_length=win_len,
            window=win,
            center=True,
            return_complex=True,
        )
        mag = torch.sqrt(spec.real.square() + spec.imag.square() + 1e-9)
        mel = torch.matmul(fb, mag)
        return torch.log(mel.clamp(min=1e-5))

    def forward(self, y_fake: torch.Tensor, y_real: torch.Tensor) -> torch.Tensor:
        total = y_fake.new_zeros((), dtype=torch.float32)
        for i in range(len(self.specs)):
            total = total + F.l1_loss(self._log_mel(y_fake, i), self._log_mel(y_real, i))
        return total / float(len(self.specs))


def lsgan_discriminator_loss(
    real_logits: Iterable[torch.Tensor],
    fake_logits: Iterable[torch.Tensor],
) -> torch.Tensor:
    loss = None
    for dr, df in zip(real_logits, fake_logits):
        cur = torch.mean((1.0 - dr) ** 2) + torch.mean(df ** 2)
        loss = cur if loss is None else (loss + cur)
    return loss if loss is not None else torch.tensor(0.0)


def lsgan_generator_loss(fake_logits: Iterable[torch.Tensor]) -> torch.Tensor:
    loss = None
    for df in fake_logits:
        cur = torch.mean((1.0 - df) ** 2)
        loss = cur if loss is None else (loss + cur)
    return loss if loss is not None else torch.tensor(0.0)


def feature_matching_loss(
    fmaps_real: Sequence[Sequence[torch.Tensor]],
    fmaps_fake: Sequence[Sequence[torch.Tensor]],
) -> torch.Tensor:
    total = None
    for fr_list, ff_list in zip(fmaps_real, fmaps_fake):
        for fr, ff in zip(fr_list, ff_list):
            cur = F.l1_loss(ff, fr.detach())
            total = cur if total is None else (total + cur)
    return (total * 2.0) if total is not None else torch.tensor(0.0)


def extract_wavlm_l6_differentiable(
    wavlm: Any,
    wav_16k: torch.Tensor,
    valid_mask_50hz: Optional[torch.Tensor] = None,
    *,
    use_bf16: bool = True,
) -> torch.Tensor:
    """Differentiable first-6-layer WavLM L6 normalized features matching FrozenWavLM[:, 6, :, :]."""
    bsz, n_samples = wav_16k.shape
    target_frames = n_samples // WAVLM_HOP_SAMPLES
    valid_samples = (
        valid_mask_50hz.sum(dim=1).long() * WAVLM_HOP_SAMPLES
        if valid_mask_50hz is not None
        else None
    )
    normed = normalize_waveform_for_wavlm(wav_16k.float(), valid_samples)
    padded = F.pad(normed, (40, 40))
    attn_mask = None
    if valid_samples is not None:
        total_valid = valid_samples + 80
        idx = torch.arange(padded.shape[1], device=padded.device).unsqueeze(0)
        attn_mask = (idx < total_valid.unsqueeze(1)).long()

    amp_enabled = bool(use_bf16 and wav_16k.is_cuda)
    m = wavlm.model
    enc = m.encoder
    with torch.amp.autocast("cuda", dtype=torch.bfloat16, enabled=amp_enabled):
        ext = m.feature_extractor(padded).transpose(1, 2)
        if attn_mask is not None:
            attn_mask = m._get_feature_vector_attention_mask(
                ext.shape[1], attn_mask, add_adapter=False
            )
        h, _ = m.feature_projection(ext)
        if attn_mask is not None:
            h = h.masked_fill(~attn_mask.unsqueeze(-1), 0.0)
        h = h + enc.pos_conv_embed(h)
        h = enc.dropout(h)
        pos_bias = None
        for layer in enc.layers[:6]:
            h, pos_bias = layer(h, attention_mask=attn_mask, position_bias=pos_bias)

    if h.shape[1] > target_frames:
        h = h[:, :target_frames, :]
    elif h.shape[1] < target_frames:
        h = F.pad(h, (0, 0, 0, target_frames - h.shape[1]))
    h_f = h.float()
    return F.layer_norm(h_f, (h_f.shape[-1],)) * 0.25


# Official unified model class aliases (backward-compatible)
Tract2VoxLarge = ConditionalHiFiGenerator27
Tract2VoxLite = ConditionalHiFiGenerator27
