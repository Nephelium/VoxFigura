"""TensorTract3 neural components: FrozenWavLM, PressureEncoder, AcousticDecoder, MotorEncoder."""
from __future__ import annotations

from pathlib import Path
from typing import Optional

import torch
import torch.nn as nn
import torch.nn.functional as F
from transformers import WavLMModel

from .constants import HF_CACHE_DIR, WAVLM_HOP_SAMPLES


def normalize_waveform_for_wavlm(
    wav: torch.Tensor,
    valid_samples: Optional[torch.Tensor] = None,
) -> torch.Tensor:
    """按 Wav2Vec2/WavLM 标准对每条波形在有效区间做零均值单位方差归一化。"""
    # wav: (B, L)
    if valid_samples is None:
        mean = wav.mean(dim=-1, keepdim=True)
        var = wav.var(dim=-1, unbiased=False, keepdim=True)
        std = torch.sqrt(var + 1e-7)
        # 若整条近似静音，不做放大
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


def add_waveform_noise(
    wav: torch.Tensor,
    valid_mask_50hz: Optional[torch.Tensor] = None,
    snr_min_db: float = 12.0,
    snr_max_db: float = 32.0,
    prob: float = 0.5,
) -> torch.Tensor:
    """可选在线轻量加噪增强（不破坏干净目标特征）。"""
    if prob <= 0.0:
        return wav
    bsz, length = wav.shape
    device = wav.device
    apply_mask = (torch.rand(bsz, 1, device=device) < prob).to(wav.dtype)
    if not apply_mask.any():
        return wav
    sig_rms = torch.sqrt(torch.mean(wav * wav, dim=-1, keepdim=True) + 1e-9)
    snr_db = snr_min_db + (snr_max_db - snr_min_db) * torch.rand(bsz, 1, device=device)
    noise_rms = sig_rms * torch.pow(10.0, -snr_db / 20.0)
    noise = torch.randn_like(wav) * noise_rms
    if valid_mask_50hz is not None:
        # 仅在有效帧对应的采样区加噪，padding 区保持 0
        mask_wav = valid_mask_50hz.unsqueeze(-1).expand(-1, -1, WAVLM_HOP_SAMPLES).reshape(bsz, -1)
        noise = noise * mask_wav[:, :length].to(wav.dtype)
    return wav + apply_mask * noise


class FrozenWavLM(nn.Module):
    """冻结的 microsoft/wavlm-large 特征提取器，输出全部 25 层 50 Hz 隐状态。"""

    def __init__(self, cache_dir: Path = HF_CACHE_DIR) -> None:
        super().__init__()
        cache_dir = Path(cache_dir)
        cache_dir.mkdir(parents=True, exist_ok=True)
        self.model = WavLMModel.from_pretrained(
            "microsoft/wavlm-large",
            cache_dir=str(cache_dir),
        )
        for p in self.model.parameters():
            p.requires_grad_(False)
        self.model.eval()

    def train(self, mode: bool = True):
        # 始终保持冻结与 eval 模式
        super().train(False)
        self.model.eval()
        return self

    @torch.no_grad()
    def forward(
        self,
        wav_16k: torch.Tensor,
        valid_mask_50hz: Optional[torch.Tensor] = None,
        use_bf16: bool = True,
        keep_bf16: bool = False,
    ) -> torch.Tensor:
        """
        Args:
            wav_16k: (B, T * 320) 16 kHz float32 波形
            valid_mask_50hz: (B, T) float/bool 有效帧掩码
            keep_bf16: True 且启用 bf16 时直接返回 bfloat16，减少显存带宽开销
        Returns:
            hidden_states: (B, 25, T, 1024) 25 层隐状态（层 0 为 CNN 投影，1..24 为 Transformer）
        """
        bsz, n_samples = wav_16k.shape
        target_frames = n_samples // WAVLM_HOP_SAMPLES

        valid_samples = None
        if valid_mask_50hz is not None:
            valid_samples = valid_mask_50hz.sum(dim=1).long() * WAVLM_HOP_SAMPLES
        normed = normalize_waveform_for_wavlm(wav_16k, valid_samples)

        # 左右各补 40 样点（共 80 样点），使 CNN 感受野严格对齐并输出 target_frames 帧
        padded = F.pad(normed, (40, 40))
        attn_mask = None
        if valid_samples is not None:
            total_valid = valid_samples + 80
            idx = torch.arange(padded.shape[1], device=padded.device).unsqueeze(0)
            attn_mask = (idx < total_valid.unsqueeze(1)).long()

        amp_enabled = use_bf16 and wav_16k.is_cuda
        with torch.amp.autocast(device_type="cuda", dtype=torch.bfloat16, enabled=amp_enabled):
            outputs = self.model(
                input_values=padded,
                attention_mask=attn_mask,
                output_hidden_states=True,
            )
            # transformers WavLMEncoderStableLayerNorm 的 hidden_states[-1] 未经最终 layer_norm (std~43),
            # 必须以 outputs.last_hidden_state (post-LN, std~0.23) 作为第 24 层目标特征
            layers_25 = (*outputs.hidden_states[:-1], outputs.last_hidden_state)
            stacked = torch.stack(layers_25, dim=1)  # (B, 25, T_out, 1024)

        if stacked.shape[2] != target_frames:
            if stacked.shape[2] > target_frames:
                stacked = stacked[:, :, :target_frames, :]
            else:
                stacked = F.pad(stacked, (0, 0, 0, target_frames - stacked.shape[2]))
        if keep_bf16 and amp_enabled:
            return stacked.to(torch.bfloat16)
        return stacked.float()


class LayerWeightedSum(nn.Module):
    """可学习 Softmax 加权融合 25 层 WavLM 特征。"""

    def __init__(self, num_layers: int = 25) -> None:
        super().__init__()
        self.logits = nn.Parameter(torch.zeros(num_layers))

    def forward(self, hidden_states: torch.Tensor) -> torch.Tensor:
        # hidden_states: (B, 25, T, D); 各层原生 std 跨度很大 (2.8..33.2 vs 0.23), 按通道做无参 LN 对齐尺度
        normed = F.layer_norm(hidden_states, (hidden_states.shape[-1],))
        w = torch.softmax(self.logits, dim=0).to(normed.dtype).view(1, -1, 1, 1)
        return (normed * w).sum(dim=1)


class ConvNeXtBlock1D(nn.Module):
    """1D ConvNeXt 模块（参考 Liu et al., 2022；TT3 PR-Encoder 采用 kernel=31, exp=4）。"""

    def __init__(self, dim: int = 192, expansion: int = 4, kernel_size: int = 31) -> None:
        super().__init__()
        pad = kernel_size // 2
        self.dwconv = nn.Conv1d(dim, dim, kernel_size=kernel_size, padding=pad, groups=dim)
        self.norm = nn.LayerNorm(dim)
        self.pwconv1 = nn.Linear(dim, dim * expansion)
        self.act = nn.GELU()
        self.pwconv2 = nn.Linear(dim * expansion, dim)
        self.gamma = nn.Parameter(torch.ones(dim) * 1e-2)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # x: (B, T, C)
        residual = x
        h = self.dwconv(x.transpose(1, 2)).transpose(1, 2)
        h = self.norm(h)
        h = self.pwconv2(self.act(self.pwconv1(h)))
        return residual + h * self.gamma


class RelPosSelfAttention(nn.Module):
    """带相对位置偏移的多头自注意力（用于 Conformer）。"""

    def __init__(self, dim: int = 192, heads: int = 4, max_rel_dist: int = 512, dropout: float = 0.1) -> None:
        super().__init__()
        if dim % heads != 0:
            raise ValueError(f"dim={dim} 必须整除 heads={heads}")
        self.heads = heads
        self.head_dim = dim // heads
        self.scale = self.head_dim ** -0.5
        self.max_rel_dist = max_rel_dist

        self.to_qkv = nn.Linear(dim, dim * 3, bias=False)
        self.rel_emb = nn.Embedding(2 * max_rel_dist + 1, self.head_dim)
        self.to_out = nn.Linear(dim, dim)
        self.dropout = nn.Dropout(dropout)

    def forward(self, x: torch.Tensor, valid_mask: Optional[torch.Tensor] = None) -> torch.Tensor:
        # x: (B, T, C), valid_mask: (B, T) True=有效
        bsz, seq_len, _ = x.shape
        qkv = self.to_qkv(x).view(bsz, seq_len, 3, self.heads, self.head_dim)
        q, k, v = qkv.unbind(dim=2)  # each: (B, T, H, D)
        q = q.transpose(1, 2)        # (B, H, T, D)
        k = k.transpose(1, 2)
        v = v.transpose(1, 2)

        dots = torch.matmul(q, k.transpose(-2, -1)) * self.scale  # (B, H, T, T)

        pos = torch.arange(seq_len, device=x.device)
        rel_idx = (pos[:, None] - pos[None, :]).clamp(-self.max_rel_dist, self.max_rel_dist) + self.max_rel_dist
        rel_k = self.rel_emb(rel_idx)  # (T, T, D)
        pos_bias = torch.einsum("b h i d, i j d -> b h i j", q, rel_k) * self.scale
        dots = dots + pos_bias

        if valid_mask is not None:
            key_mask = valid_mask.bool().view(bsz, 1, 1, seq_len)
            dots = dots.masked_fill(~key_mask, torch.finfo(dots.dtype).min)

        attn = torch.softmax(dots, dim=-1)
        attn = self.dropout(attn)
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
        # x: (B, T, C)
        h = self.norm(x).transpose(1, 2)
        a, b = self.pw1(h).chunk(2, dim=1)
        h = a * torch.sigmoid(b)
        if valid_mask is not None:
            h = h * valid_mask.unsqueeze(1).to(h.dtype)
        h = self.dw(h)
        h = self.bn(h)
        h = F.silu(h)
        h = self.pw2(h).transpose(1, 2)
        return self.drop(h)


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


def _run_masked_bilstm(
    lstm: nn.LSTM,
    x: torch.Tensor,
    valid_mask: Optional[torch.Tensor],
) -> torch.Tensor:
    if valid_mask is None or bool(valid_mask.bool().all()):
        out, _ = lstm(x)
        return out
    lengths = valid_mask.long().sum(dim=1).clamp(min=1).cpu()
    packed = nn.utils.rnn.pack_padded_sequence(x, lengths, batch_first=True, enforce_sorted=False)
    packed_out, _ = lstm(packed)
    out, _ = nn.utils.rnn.pad_packed_sequence(packed_out, batch_first=True, total_length=x.shape[1])
    return out


class PressureEncoder(nn.Module):
    """ESSV 2026 §2.2 肺压编码器：25层WavLM加权和 + 8块ConvNeXt(192, k=31) + 双向LSTM -> PR([-1,1])。"""

    def __init__(
        self,
        in_channels: int = 1024,
        hidden_dim: int = 192,
        num_blocks: int = 8,
        kernel_size: int = 31,
    ) -> None:
        super().__init__()
        self.layer_sum = LayerWeightedSum(25)
        self.in_proj = nn.Conv1d(in_channels, hidden_dim, kernel_size=1)
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

    def forward(self, wavlm_25: torch.Tensor, valid_mask: Optional[torch.Tensor] = None) -> torch.Tensor:
        # wavlm_25: (B, 25, T, 1024)
        x = self.layer_sum(wavlm_25)  # (B, T, 1024)
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


class AcousticDecoder(nn.Module):
    """ESSV 2026 §2.2 声学解码器：22维归一化控制轨迹 -> Conformer -> WavLM第24层特征。"""

    def __init__(
        self,
        in_channels: int = 22,
        hidden_dim: int = 192,
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
        self.out_proj = nn.Conv1d(hidden_dim, out_channels, kernel_size=1)

    def forward(self, m22_norm: torch.Tensor, valid_mask: Optional[torch.Tensor] = None) -> torch.Tensor:
        # m22_norm: (B, T, 22)
        x = self.in_proj(m22_norm.transpose(1, 2)).transpose(1, 2)
        if valid_mask is not None:
            x = x * valid_mask.unsqueeze(-1).to(x.dtype)
        for blk in self.blocks:
            x = blk(x, valid_mask=valid_mask)
        out = self.out_proj(x.transpose(1, 2)).transpose(1, 2)
        if valid_mask is not None:
            out = out * valid_mask.unsqueeze(-1).to(out.dtype)
        return out  # (B, T, 1024)


class MotorEncoder(nn.Module):
    """ESSV 2026 §2.2 主构音编码器（支持 T24 和 WS 模式）：WavLM -> Conformer + BiLSTM -> m20([-1,1])。"""

    def __init__(
        self,
        mode: str = "T24",
        in_channels: int = 1024,
        hidden_dim: int = 192,
        out_channels: int = 20,
        num_layers: int = 8,
        num_heads: int = 4,
        kernel_size: int = 31,
        dropout: float = 0.1,
    ) -> None:
        super().__init__()
        if mode not in ("T24", "WS"):
            raise ValueError(f"未知的 MotorEncoder 模式: {mode}")
        self.mode = mode
        self.layer_sum = LayerWeightedSum(25) if mode == "WS" else None
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
        self.lstm = nn.LSTM(
            input_size=hidden_dim,
            hidden_size=hidden_dim,
            num_layers=1,
            batch_first=True,
            bidirectional=True,
        )
        self.out_proj = nn.Conv1d(hidden_dim * 2, out_channels, kernel_size=1)

    def forward(self, wavlm_25: torch.Tensor, valid_mask: Optional[torch.Tensor] = None) -> torch.Tensor:
        # wavlm_25: (B, 25, T, 1024) 或若为 (B, T, 1024) 且 mode=='T24' 亦可兼容
        if wavlm_25.ndim == 4:
            x = wavlm_25[:, 24, :, :] if self.mode == "T24" else self.layer_sum(wavlm_25)
        else:
            x = wavlm_25
        x = self.in_proj(x.transpose(1, 2)).transpose(1, 2)
        if valid_mask is not None:
            x = x * valid_mask.unsqueeze(-1).to(x.dtype)
        for blk in self.blocks:
            x = blk(x, valid_mask=valid_mask)
        x = _run_masked_bilstm(self.lstm, x, valid_mask)
        out = torch.tanh(self.out_proj(x.transpose(1, 2)).transpose(1, 2))
        if valid_mask is not None:
            out = out * valid_mask.unsqueeze(-1).to(out.dtype)
        return out  # (B, T, 20)
