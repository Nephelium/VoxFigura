"""Browser-ready lightweight models for M27 Stage 4 (inversion) and Stage 5 (speaker encoder).

All modules are 100% WavLM-free, pure PyTorch / ONNX-friendly, and exportable to FP16 & per-channel INT8:
  - BrowserLightM27Inverter   (~7.4M params, FP16 ~14.2 MB, INT8 ~7.1 MB)
  - BrowserLightSpeakerEncoder (~2.2M params, FP16 ~4.2 MB, INT8 ~2.1 MB, aligned to 512-d WavLM-SV space)
  - Generic FP16 & per-channel symmetric INT8 weight pack / unpack helpers (also usable on Stage 5 lite vocoder)
"""
from __future__ import annotations

import hashlib
from pathlib import Path
import queue
import threading
from typing import Any, Callable, Dict, List, Optional, Tuple

import torch
import torch.nn as nn
import torch.nn.functional as F

from .constants import SAMPLE_RATE_16K, WAVLM_HOP_SAMPLES
from .distill_models import PureLogMel50Hz, build_mel_filterbank
from .m27_models import VoiceQualityFrontend50Hz
from .models import ConformerBlock, ConvNeXtBlock1D, _run_masked_bilstm, normalize_waveform_for_wavlm


class BrowserLightM27Inverter(nn.Module):
    """WavLM-free browser M27 inverter: (wav_16k, f0_norm) -> (tract17, pr1, glottis8).

    Architecture:
      - Frontend: PureLogMel50Hz (80 mel + 80 delta + 3 rel-energy/HF-LF) + VoiceQualityFrontend50Hz (3) + f0_norm (1) = 167-d @ 50 Hz
      - Shared acoustic backbone: 2-layer Conv1d stem + 6x ConformerBlock(hidden_dim=192)
      - Decoupled physics-aware heads:
          * pr_head:      backbone + explicit energy/VQ cues -> Conv1d stack -> 1-d PR (0..16000 dPa norm)
          * tract_head:   BiLSTM(192) -> 17-d vocal tract controls
          * glottis_head: [backbone, f0_norm, pr_hat, vq_cues] -> 2x ConvNeXtBlock1D(128) + BiLSTM(128) -> 8-d glottis
    """

    def __init__(
        self,
        n_mels: int = 80,
        hidden_dim: int = 192,
        num_layers: int = 6,
        num_heads: int = 4,
        conv_kernel_size: int = 31,
        glottis_dim: int = 128,
        glottis_blocks: int = 2,
        dropout: float = 0.05,
    ) -> None:
        super().__init__()
        self.n_mels = int(n_mels)
        self.hidden_dim = int(hidden_dim)
        self.num_layers = int(num_layers)
        self.num_heads = int(num_heads)
        self.conv_kernel_size = int(conv_kernel_size)
        self.glottis_dim = int(glottis_dim)
        self.glottis_blocks = int(glottis_blocks)
        self.dropout = float(dropout)

        self.mel = PureLogMel50Hz(n_mels=self.n_mels, use_energy_feats=True)
        self.vq_frontend = VoiceQualityFrontend50Hz()
        in_dim = self.mel.out_dim + 3 + 1  # 163 + 3 VQ + 1 F0 = 167

        self.stem = nn.Sequential(
            nn.Conv1d(in_dim, self.hidden_dim, kernel_size=5, padding=2),
            nn.GELU(),
            nn.Conv1d(self.hidden_dim, self.hidden_dim, kernel_size=3, padding=1),
            nn.GELU(),
        )
        self.stem_norm = nn.LayerNorm(self.hidden_dim)

        self.blocks = nn.ModuleList(
            [
                ConformerBlock(
                    dim=self.hidden_dim,
                    heads=self.num_heads,
                    ff_mult=4,
                    conv_kernel_size=self.conv_kernel_size,
                    dropout=self.dropout,
                )
                for _ in range(self.num_layers)
            ]
        )

        # Head 1: Subglottal pressure (PR) with explicit energy & VQ skip connection
        self.pr_head = nn.Sequential(
            nn.Conv1d(self.hidden_dim + 6, 96, kernel_size=5, padding=2),
            nn.GELU(),
            nn.Conv1d(96, 96, kernel_size=3, padding=1),
            nn.GELU(),
            nn.Conv1d(96, 1, kernel_size=1),
        )

        # Head 2: 17-dim supraglottal vocal tract trajectory
        self.tract_lstm = nn.LSTM(
            input_size=self.hidden_dim,
            hidden_size=self.hidden_dim,
            num_layers=1,
            batch_first=True,
            bidirectional=True,
        )
        self.tract_proj = nn.Conv1d(self.hidden_dim * 2, 17, kernel_size=1)

        # Head 3: 8-dim full-native glottis / phonation branch conditioned on [backbone, F0, PR, VQ]
        self.glottis_in = nn.Conv1d(self.hidden_dim + 5, self.glottis_dim, kernel_size=1)
        self.glottis_convs = nn.ModuleList(
            [
                ConvNeXtBlock1D(dim=self.glottis_dim, expansion=3, kernel_size=15)
                for _ in range(self.glottis_blocks)
            ]
        )
        self.glottis_lstm = nn.LSTM(
            input_size=self.glottis_dim,
            hidden_size=self.glottis_dim,
            num_layers=1,
            batch_first=True,
            bidirectional=True,
        )
        self.glottis_proj = nn.Conv1d(self.glottis_dim * 2, 8, kernel_size=1)

    def get_arch_config(self) -> Dict[str, Any]:
        return {
            "n_mels": self.n_mels,
            "hidden_dim": self.hidden_dim,
            "num_layers": self.num_layers,
            "num_heads": self.num_heads,
            "conv_kernel_size": self.conv_kernel_size,
            "glottis_dim": self.glottis_dim,
            "glottis_blocks": self.glottis_blocks,
            "dropout": self.dropout,
        }

    @classmethod
    def from_arch_config(cls, cfg: Optional[Dict[str, Any]]) -> "BrowserLightM27Inverter":
        if not cfg:
            return cls()
        return cls(**{k: cfg[k] for k in (
            "n_mels", "hidden_dim", "num_layers", "num_heads",
            "conv_kernel_size", "glottis_dim", "glottis_blocks", "dropout",
        ) if k in cfg})

    def count_parameters(self) -> int:
        return sum(p.numel() for p in self.parameters())

    def forward_with_features(
        self,
        wav_16k: torch.Tensor,
        f0_norm: torch.Tensor,
        valid_mask: Optional[torch.Tensor] = None,
    ) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
        """Same as `forward()`, plus returns the 192-d 50 Hz Conformer backbone hidden state `h`
        so downstream heads (e.g. `Vox2Align-Lite`) share the exact frozen acoustic backbone
        with zero duplicate compute or weights.
        """
        if f0_norm.ndim == 2:
            f0_in = f0_norm.unsqueeze(-1)
        else:
            f0_in = f0_norm

        mel_feats = self.mel(wav_16k, valid_mask_50hz=valid_mask)  # (B, T, 163)
        vq_cues = self.vq_frontend(wav_16k, valid_mask=valid_mask).to(mel_feats.dtype)  # (B, T, 3)
        energy_cues = mel_feats[..., -3:]  # (B, T, 3)
        f0_t = f0_in.to(mel_feats.dtype)

        x_in = torch.cat([mel_feats, vq_cues, f0_t], dim=-1)
        x = self.stem(x_in.transpose(1, 2)).transpose(1, 2)
        x = self.stem_norm(x)
        if valid_mask is not None:
            m = valid_mask.unsqueeze(-1).to(x.dtype)
            x = x * m
        for blk in self.blocks:
            x = blk(x, valid_mask=valid_mask)
        h_backbone = x

        # 1. PR head
        pr_in = torch.cat([x, energy_cues, vq_cues], dim=-1).transpose(1, 2)
        pr1 = torch.tanh(self.pr_head(pr_in).transpose(1, 2))

        # 2. Tract 17 head
        t_h = _run_masked_bilstm(self.tract_lstm, x, valid_mask)
        tract17 = torch.tanh(self.tract_proj(t_h.transpose(1, 2)).transpose(1, 2))

        # 3. Glottis 8 head (conditioned on predicted PR + F0 + VQ cues)
        g_in = torch.cat([x, f0_t, pr1, vq_cues], dim=-1)
        g = self.glottis_in(g_in.transpose(1, 2)).transpose(1, 2)
        if valid_mask is not None:
            g = g * valid_mask.unsqueeze(-1).to(g.dtype)
        for gblk in self.glottis_convs:
            g = gblk(g)
            if valid_mask is not None:
                g = g * valid_mask.unsqueeze(-1).to(g.dtype)
        g = _run_masked_bilstm(self.glottis_lstm, g, valid_mask)
        glot8 = torch.tanh(self.glottis_proj(g.transpose(1, 2)).transpose(1, 2))

        if valid_mask is not None:
            m_out = valid_mask.unsqueeze(-1).to(tract17.dtype)
            tract17 = tract17 * m_out
            pr1 = pr1 * m_out
            glot8 = glot8 * m_out
            h_backbone = h_backbone * m_out
        return tract17, pr1, glot8, h_backbone

    def forward(
        self,
        wav_16k: torch.Tensor,
        f0_norm: torch.Tensor,
        valid_mask: Optional[torch.Tensor] = None,
    ) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        """
        Args:
            wav_16k: (B, T * 320) 16 kHz float32 waveform
            f0_norm: (B, T) or (B, T, 1) normalized log-F0 in [-1, 1]
            valid_mask: optional (B, T) float/bool mask
        Returns:
            tract17: (B, T, 17) in [-1, 1]
            pr1:     (B, T, 1)  in [-1, 1]
            glot8:   (B, T, 8)  in [-1, 1]
        """
        tract17, pr1, glot8, _ = self.forward_with_features(wav_16k, f0_norm, valid_mask=valid_mask)
        return tract17, pr1, glot8


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
        w = torch.sigmoid(self.fc2(F.silu(self.fc1(s))))
        return x * w


class _SERes2Block(nn.Module):
    """ECAPA-TDNN Squeeze-and-Excitation Res2Net block."""

    def __init__(self, channels: int, kernel_size: int = 3, dilation: int = 2, scale: int = 4) -> None:
        super().__init__()
        assert channels % scale == 0
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
        out = torch.cat(ys, dim=1)
        out = self.bn3(self.conv3(out))
        out = self.se(out, mask=mask)
        out = F.silu(out + residual)
        if mask is not None:
            out = out * mask.unsqueeze(1).to(out.dtype)
        return out


class BrowserLightSpeakerEncoder(nn.Module):
    """Lightweight ECAPA-TDNN speaker encoder (~2.2M params) distilled into WavLM-Base-Plus-SV 512-d space.

    Uses per-utterance Cepstral Mean Normalization (CMN only, preserving per-band spectral shape / formants)
    on 80-dim 50 Hz Slaney Log-Mel spectrograms, followed by 3x SE-Res2Blocks, Multi-layer Feature Aggregation,
    Attentive Statistics Pooling, and L2-normalized 512-d projection.
    """

    def __init__(
        self,
        sr: int = SAMPLE_RATE_16K,
        n_fft: int = 1024,
        win_length: int = 640,
        hop_length: int = WAVLM_HOP_SAMPLES,
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

        self.mfa = nn.Sequential(
            nn.Conv1d(self.channels * 3, self.mfa_dim, kernel_size=1),
            nn.SiLU(),
        )
        self.attn = nn.Sequential(
            nn.Conv1d(self.mfa_dim * 3, 128, kernel_size=1),
            nn.Tanh(),
            nn.Conv1d(128, self.mfa_dim, kernel_size=1),
        )
        self.bn_pool = nn.BatchNorm1d(self.mfa_dim * 2)
        self.fc = nn.Linear(self.mfa_dim * 2, self.emb_dim)
        self.bn_out = nn.BatchNorm1d(self.emb_dim)

    def get_arch_config(self) -> Dict[str, Any]:
        return {
            "sr": self.sr,
            "n_fft": self.n_fft,
            "win_length": self.win_length,
            "hop_length": self.hop_length,
            "n_mels": self.n_mels,
            "channels": self.channels,
            "mfa_dim": self.mfa_dim,
            "emb_dim": self.emb_dim,
        }

    @classmethod
    def from_arch_config(cls, cfg: Optional[Dict[str, Any]]) -> "BrowserLightSpeakerEncoder":
        if not cfg:
            return cls()
        return cls(**{k: cfg[k] for k in (
            "sr", "n_fft", "win_length", "hop_length", "n_mels", "channels", "mfa_dim", "emb_dim"
        ) if k in cfg})

    def count_parameters(self) -> int:
        return sum(p.numel() for p in self.parameters())

    def _extract_cmn_logmel(
        self,
        wav_16k: torch.Tensor,
        valid_samples: Optional[torch.Tensor] = None,
    ) -> Tuple[torch.Tensor, Optional[torch.Tensor]]:
        x = wav_16k.float()
        bsz, n_samples = x.shape
        target_frames = max(1, n_samples // self.hop_length)
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
        power = spec.real.square() + spec.imag.square()
        if power.shape[-1] > target_frames:
            power = power[..., :target_frames]
        elif power.shape[-1] < target_frames:
            power = F.pad(power, (0, target_frames - power.shape[-1]))

        mel = torch.matmul(self.mel_fb, power)
        log_mel = torch.log(mel.clamp(min=1e-6))  # (B, n_mels, T)

        frame_mask: Optional[torch.Tensor] = None
        if valid_samples is not None:
            valid_f = (valid_samples // self.hop_length).clamp(min=1, max=target_frames)
            idx = torch.arange(target_frames, device=wav_16k.device).unsqueeze(0)
            frame_mask = (idx < valid_f.unsqueeze(1)).float()
            m = frame_mask.unsqueeze(1)
            mean = (log_mel * m).sum(dim=-1, keepdim=True) / m.sum(dim=-1, keepdim=True).clamp(min=1.0)
            log_mel = (log_mel - mean) * m
        else:
            log_mel = log_mel - log_mel.mean(dim=-1, keepdim=True)
        return log_mel, frame_mask

    def forward(
        self,
        wav_16k: torch.Tensor,
        valid_samples: Optional[torch.Tensor] = None,
    ) -> torch.Tensor:
        """Compute L2-normalized `(B, 512)` float32 speaker embedding."""
        x, fmask = self._extract_cmn_logmel(wav_16k, valid_samples)  # (B, 80, T)
        x = self.in_conv(x)
        if fmask is not None:
            x = x * fmask.unsqueeze(1).to(x.dtype)
        x1 = self.layer1(x, mask=fmask)
        x2 = self.layer2(x1, mask=fmask)
        x3 = self.layer3(x2, mask=fmask)
        h = self.mfa(torch.cat([x1, x2, x3], dim=1))  # (B, mfa_dim, T)

        if fmask is not None:
            m = fmask.unsqueeze(1).to(h.dtype)
            denom = m.sum(dim=-1, keepdim=True).clamp(min=1.0)
            g_mean = (h * m).sum(dim=-1, keepdim=True) / denom
            g_std = torch.sqrt((((h - g_mean) ** 2) * m).sum(dim=-1, keepdim=True) / denom + 1e-5)
        else:
            g_mean = h.mean(dim=-1, keepdim=True)
            g_std = torch.sqrt(h.var(dim=-1, unbiased=False, keepdim=True) + 1e-5)

        t_len = h.shape[-1]
        attn_in = torch.cat([h, g_mean.expand(-1, -1, t_len), g_std.expand(-1, -1, t_len)], dim=1)
        w_logits = self.attn(attn_in)
        if fmask is not None:
            w_logits = w_logits.masked_fill(fmask.unsqueeze(1) < 0.5, -1e4)
        w = torch.softmax(w_logits, dim=-1)

        mu = (h * w).sum(dim=-1)
        sg = torch.sqrt((((h - mu.unsqueeze(-1)) ** 2) * w).sum(dim=-1).clamp(min=1e-6))
        stats = self.bn_pool(torch.cat([mu, sg], dim=1))
        emb = self.bn_out(self.fc(stats))
        return F.normalize(emb.float(), p=2, dim=-1)


# =============================================================================
# Generic FP16 & Per-Channel Symmetric INT8 Weight Export / Loader
# =============================================================================
def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with Path(path).open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def quantize_state_dict_int8(state_dict: Dict[str, torch.Tensor]) -> Dict[str, Any]:
    """Per-output-channel symmetric INT8 quantization for 2D/3D weights; keep 1D biases/norms in FP16."""
    q_tensors: Dict[str, torch.Tensor] = {}
    scales: Dict[str, torch.Tensor] = {}
    for k, v in state_dict.items():
        t = v.detach().cpu()
        if t.is_floating_point() and t.ndim >= 2 and t.numel() >= 256:
            t_f = t.float()
            flat = t_f.reshape(t_f.shape[0], -1)
            max_abs = flat.abs().amax(dim=1).clamp(min=1e-8)
            sc = (max_abs / 127.0).to(torch.float16)
            sc_view = sc.float().reshape([t_f.shape[0]] + [1] * (t_f.ndim - 1))
            q = torch.round(t_f / sc_view).clamp(-127, 127).to(torch.int8)
            q_tensors[k] = q
            scales[k] = sc
        elif t.is_floating_point():
            q_tensors[k] = t.half()
        else:
            q_tensors[k] = t
    return {"tensors": q_tensors, "scales": scales}


def dequantize_state_dict_int8(packed: Dict[str, Any]) -> Dict[str, torch.Tensor]:
    q_tensors: Dict[str, torch.Tensor] = packed["tensors"]
    scales: Dict[str, torch.Tensor] = packed["scales"]
    out: Dict[str, torch.Tensor] = {}
    for k, v in q_tensors.items():
        if k in scales:
            sc = scales[k].float()
            sc_view = sc.reshape([v.shape[0]] + [1] * (v.ndim - 1))
            out[k] = v.float() * sc_view
        elif v.is_floating_point():
            out[k] = v.float()
        else:
            out[k] = v
    return out


def export_fp16_weights(
    state_dict: Dict[str, torch.Tensor],
    out_path: Path,
    *,
    schema: str,
    arch_config: Dict[str, Any],
    meta: Dict[str, Any],
) -> Path:
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    fp16_sd = {
        k: (v.detach().cpu().half() if v.is_floating_point() else v.detach().cpu())
        for k, v in state_dict.items()
    }
    tmp = out_path.with_suffix(".tmp.pt")
    torch.save({"schema": schema, "config": arch_config, "meta": meta, "state_dict": fp16_sd}, tmp)
    tmp.replace(out_path)
    return out_path


def export_int8_weights(
    state_dict: Dict[str, torch.Tensor],
    out_path: Path,
    *,
    schema: str,
    arch_config: Dict[str, Any],
    meta: Dict[str, Any],
) -> Path:
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    packed = quantize_state_dict_int8(state_dict)
    tmp = out_path.with_suffix(".tmp.pt")
    torch.save({"schema": schema, "config": arch_config, "meta": meta, "quantized": packed}, tmp)
    tmp.replace(out_path)
    return out_path


def load_lite_state_dict(
    weights_path: Path,
    map_location: str = "cpu",
) -> Tuple[Dict[str, torch.Tensor], Dict[str, Any]]:
    raw = torch.load(Path(weights_path), map_location=map_location, weights_only=False)
    if "quantized" in raw:
        return dequantize_state_dict_int8(raw["quantized"]), raw
    if "state_dict" in raw:
        return {k: (v.float() if v.is_floating_point() else v) for k, v in raw["state_dict"].items()}, raw
    if "generator" in raw:
        return raw["generator"], raw
    if "model" in raw:
        return raw["model"], raw
    raise ValueError(f"Unsupported lite weight schema in {weights_path}")


class AsyncBatchPrefetcher:
    """Multi-threaded asynchronous CPU->pinned-memory batch prefetcher to keep RTX 5090 saturated."""

    def __init__(
        self,
        make_worker_fn: Callable[[int], Callable[[], Tuple[Any, ...]]],
        *,
        num_workers: int = 2,
        queue_size: int = 8,
        pin_memory: bool = True,
    ) -> None:
        self.make_worker_fn = make_worker_fn
        self.num_workers = max(1, int(num_workers))
        self.pin_memory = bool(pin_memory and torch.cuda.is_available())
        self._q: queue.Queue = queue.Queue(maxsize=max(2, int(queue_size)))
        self._stop = threading.Event()
        self._threads: List[threading.Thread] = []
        self._error: Optional[BaseException] = None

    def _to_pinned_tensors(self, items: Tuple[Any, ...]) -> Tuple[torch.Tensor, ...]:
        out: List[torch.Tensor] = []
        for x in items:
            t = x if isinstance(x, torch.Tensor) else torch.from_numpy(x)
            if self.pin_memory and t.device.type == "cpu":
                t = t.pin_memory()
            out.append(t)
        return tuple(out)

    def _worker(self, wid: int) -> None:
        try:
            sample_fn = self.make_worker_fn(wid)
            while not self._stop.is_set():
                batch = self._to_pinned_tensors(sample_fn())
                while not self._stop.is_set():
                    try:
                        self._q.put(batch, timeout=0.2)
                        break
                    except queue.Full:
                        continue
        except BaseException as exc:
            self._error = exc

    def start(self) -> "AsyncBatchPrefetcher":
        if self._threads:
            return self
        self._stop.clear()
        for wid in range(self.num_workers):
            th = threading.Thread(target=self._worker, args=(wid,), daemon=True)
            th.start()
            self._threads.append(th)
        return self

    def next_batch(self) -> Tuple[torch.Tensor, ...]:
        if not self._threads:
            self.start()
        while True:
            if self._error is not None:
                raise RuntimeError(f"AsyncBatchPrefetcher worker error: {self._error}") from self._error
            try:
                return self._q.get(timeout=0.5)
            except queue.Empty:
                continue

    def stop(self) -> None:
        self._stop.set()
        while not self._q.empty():
            try:
                self._q.get_nowait()
            except queue.Empty:
                break
        for th in self._threads:
            th.join(timeout=2.0)
        self._threads.clear()

    def __enter__(self) -> "AsyncBatchPrefetcher":
        return self.start()

    def __exit__(self, exc_type, exc, tb) -> None:
        self.stop()


# Official unified model class aliases (backward-compatible)
Vox2TractLite = BrowserLightM27Inverter
Vox2SpkLite = BrowserLightSpeakerEncoder

