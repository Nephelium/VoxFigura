"""Lightweight neural components for Keyframe-to-Dynamic-Tract (KF2Tract27).

Contains:
  - TubeAreaProxy27       : Frozen differentiable R21 tube-area surrogate (~85K params, training guard)
  - KeyframeTractModel27  : Ultra-light browser-ready bidirectional Conformer + BiGRU residual model
                            (~3.8M params; FP16 ONNX ~7.6 MB, CPU inference < 15 ms for 5 s utterance)
  - kf_trajectory_loss    : Masked Huber + velocity/acceleration + tube-area closure/opening guard loss
"""
from __future__ import annotations

from pathlib import Path
from typing import Dict, Optional, Tuple

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

from .kf_baseline import KF_COND_DIM, KF_OUT_DIM
from .kf_phonetics import KF26_INDEX
from .models import ConformerBlock

# 6 physical tube-area summary targets predicted by TubeAreaProxy27 (in log1p(area_cm2) space):
#   0: min_oral_area    (overall minimum cross-sectional area along oral/velar/labial tract)
#   1: min_labial_area  (frontmost lip zone)
#   2: min_coronal_area (alveolar / tongue-tip / blade zone)
#   3: min_dorsal_area  (palatal / velar / tongue-body zone)
#   4: min_pharynx_area (pharyngeal / lower tract zone)
#   5: nasal_port_area  (velopharyngeal port area)
TUBE_PROXY_NAMES: Tuple[str, ...] = (
    "min_oral",
    "min_labial",
    "min_coronal",
    "min_dorsal",
    "min_pharynx",
    "nasal_port",
)
TUBE_PROXY_DIM = len(TUBE_PROXY_NAMES)

# Per-dimension acoustic sensitivity multiplier over the 26 predicted channels
_ACOUSTIC_SENSITIVITY_26 = np.ones(KF_OUT_DIM, dtype=np.float32)
for _col, _mult in (
    ("LD", 1.55),
    ("LP", 1.25),
    ("VO", 1.50),
    ("TCX", 1.35),
    ("TCY", 1.35),
    ("TTX", 1.45),
    ("TTY", 1.45),
    ("TBX", 1.25),
    ("TBY", 1.25),
    ("JA", 1.20),
    ("PR", 1.45),
    ("RA", 1.45),
    ("XB", 1.30),
    ("CA", 1.25),
):
    _ACOUSTIC_SENSITIVITY_26[KF26_INDEX[_col]] = _mult


def _run_masked_bigru(
    gru: nn.GRU,
    x: torch.Tensor,
    valid_mask: Optional[torch.Tensor],
) -> torch.Tensor:
    """Mask-aware BiGRU; runs pure unpacked path when valid_mask is None (ONNX friendly)."""
    if valid_mask is None:
        out, _ = gru(x)
        return out
    lengths = valid_mask.sum(dim=1).long().clamp(min=1)
    if int(lengths.min().item()) == x.shape[1]:
        out, _ = gru(x)
        return out
    packed = nn.utils.rnn.pack_padded_sequence(
        x, lengths.cpu(), batch_first=True, enforce_sorted=False
    )
    out_packed, _ = gru(packed)
    out, _ = nn.utils.rnn.pad_packed_sequence(out_packed, batch_first=True, total_length=x.shape[1])
    return out * valid_mask.unsqueeze(-1).to(out.dtype)


class _ResMLPBlock(nn.Module):
    def __init__(self, dim: int, dropout: float = 0.0) -> None:
        super().__init__()
        self.norm = nn.LayerNorm(dim)
        self.fc1 = nn.Linear(dim, dim)
        self.fc2 = nn.Linear(dim, dim)
        self.drop = nn.Dropout(dropout) if dropout > 0 else nn.Identity()

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        h = F.gelu(self.fc1(self.norm(x)))
        h = self.drop(h)
        h = self.fc2(h)
        return x + h


class TubeAreaProxy27(nn.Module):
    """Differentiable surrogate mapping normalized tract17 [-1, 1] -> 6 log1p(area_cm2) values."""

    def __init__(self, in_dim: int = 17, hidden_dim: int = 192, num_blocks: int = 3) -> None:
        super().__init__()
        self.in_proj = nn.Linear(in_dim, hidden_dim)
        self.blocks = nn.ModuleList([_ResMLPBlock(hidden_dim) for _ in range(num_blocks)])
        self.out_norm = nn.LayerNorm(hidden_dim)
        self.out_proj = nn.Linear(hidden_dim, TUBE_PROXY_DIM)

    def forward(self, tract17_norm: torch.Tensor) -> torch.Tensor:
        """Predict non-negative log1p(area_cm2) of shape (..., 6)."""
        h = F.gelu(self.in_proj(tract17_norm))
        for blk in self.blocks:
            h = blk(h)
        raw = self.out_proj(self.out_norm(h))
        return F.softplus(raw)

    def predict_area_cm2(self, tract17_norm: torch.Tensor) -> torch.Tensor:
        return torch.expm1(self.forward(tract17_norm).clamp(max=6.0)).clamp(min=0.0)


class KeyframeTractModel27(nn.Module):
    """Browser-ready residual model: (cond_111, x_base_26) -> dynamic 50 Hz [tract17, PR, glottis8].

    Architecture:
      Linear(111 -> 192) -> LN -> Conv1d(k=5) -> 4 x ConformerBlock(192, heads=4, k=15)
      -> BiGRU(192) -> Dual Zero-Init Residual Heads (17 tract + 9 source)

    Zero-initializing the final linear layers guarantees that at step 0 the network outputs the
    exact physical async qTA baseline x_base, ensuring stable convergence and monotonic alpha control.
    """

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
        # Protect jaw aperture (JA) against Stage-4 teacher jaw-flattening bias while keeping full expressivity elsewhere
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
        self._zero_init_heads()

    def _zero_init_heads(self) -> None:
        nn.init.zeros_(self.tract_head[-1].weight)
        nn.init.zeros_(self.tract_head[-1].bias)
        nn.init.zeros_(self.source_head[-1].weight)
        nn.init.zeros_(self.source_head[-1].bias)

    def forward(
        self,
        cond: torch.Tensor,
        x_base: torch.Tensor,
        valid_mask: Optional[torch.Tensor] = None,
        alpha: float = 1.0,
    ) -> Tuple[torch.Tensor, torch.Tensor]:
        """
        Args:
            cond       : (B, T, 111) float32 condition tensor
            x_base     : (B, T, 26)  float32 async qTA baseline in [-1, 1]
            valid_mask : optional (B, T) float/bool mask
            alpha      : coarticulation strength scalar (0.0 = strict baseline, 1.0 = natural residual)
        Returns:
            x_hat      : (B, T, 26) clamped to [-1, 1]
            delta      : (B, T, 26) bounded residual before scaling by alpha
        """
        h = self.in_norm(self.in_proj(cond))
        h = h + self.stem_conv(h.transpose(1, 2)).transpose(1, 2)
        if valid_mask is not None:
            h = h * valid_mask.unsqueeze(-1).to(h.dtype)
        for blk in self.blocks:
            h = blk(h, valid_mask=valid_mask)
        h = _run_masked_bigru(self.gru, h, valid_mask)

        d_tract = torch.tanh(self.tract_head(h))
        d_src = torch.tanh(self.source_head(h))
        delta = torch.cat([d_tract, d_src], dim=-1) * self.max_res_vec.to(h.dtype)
        x_hat = torch.clamp(x_base + float(alpha) * delta, -1.0, 1.0)
        if valid_mask is not None:
            m = valid_mask.unsqueeze(-1).to(x_hat.dtype)
            x_hat = x_hat * m
            delta = delta * m
        return x_hat, delta

    def count_parameters(self) -> int:
        return sum(p.numel() for p in self.parameters())


class _ONNXExportWrapper(nn.Module):
    """Thin ONNX wrapper accepting (cond, x_base, alpha_scalar) -> x_hat without mask packing."""

    def __init__(self, core: KeyframeTractModel27) -> None:
        super().__init__()
        self.core = core

    def forward(self, cond: torch.Tensor, x_base: torch.Tensor, alpha: torch.Tensor) -> torch.Tensor:
        h = self.core.in_norm(self.core.in_proj(cond))
        h = h + self.core.stem_conv(h.transpose(1, 2)).transpose(1, 2)
        for blk in self.core.blocks:
            h = blk(h, valid_mask=None)
        h, _ = self.core.gru(h)
        d_tract = torch.tanh(self.core.tract_head(h))
        d_src = torch.tanh(self.core.source_head(h))
        delta = torch.cat([d_tract, d_src], dim=-1) * self.core.max_res_vec.to(h.dtype)
        return torch.clamp(x_base + alpha * delta, -1.0, 1.0)


def export_kf_fp16_weights(
    model: KeyframeTractModel27,
    out_path: Path,
    *,
    meta: Optional[Dict[str, object]] = None,
) -> Path:
    """Save compact inference-only FP16 state dict (~8 MB) requiring zero external packages."""
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    fp16_state = {
        k: (v.detach().cpu().half() if v.is_floating_point() else v.detach().cpu())
        for k, v in model.state_dict().items()
    }
    payload = {
        "schema": "kf2tract27_fp16_v1",
        "config": {
            "cond_dim": model.cond_dim,
            "out_dim": model.out_dim,
            "hidden_dim": model.hidden_dim,
            "num_layers": len(model.blocks),
            "max_residual": model.max_residual,
        },
        "meta": meta or {},
        "state_dict": fp16_state,
    }
    torch.save(payload, out_path)
    return out_path


def export_kf_model_onnx(
    model: KeyframeTractModel27,
    out_path: Path,
    *,
    opset: int = 17,
    sample_frames: int = 100,
) -> Optional[Path]:
    """Export KeyframeTractModel27 to batch=1 dynamic-length ONNX ready for onnxruntime-web / desktop."""
    try:
        import onnx  # noqa: F401
    except ImportError:
        return None
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    was_training = model.training
    device = next(model.parameters()).device
    model_cpu = model.eval().cpu()
    wrapper = _ONNXExportWrapper(model_cpu).eval()
    dummy_cond = torch.zeros((1, sample_frames, model.cond_dim), dtype=torch.float32)
    dummy_base = torch.zeros((1, sample_frames, model.out_dim), dtype=torch.float32)
    dummy_alpha = torch.tensor([1.0], dtype=torch.float32)

    torch.onnx.export(
        wrapper,
        (dummy_cond, dummy_base, dummy_alpha),
        str(out_path),
        input_names=["cond", "x_base", "alpha"],
        output_names=["x_hat"],
        dynamic_axes={
            "cond": {1: "frames"},
            "x_base": {1: "frames"},
            "x_hat": {1: "frames"},
        },
        opset_version=opset,
        do_constant_folding=True,
    )
    model.to(device)
    model.train(was_training)
    return out_path


_LOSS_TENSOR_CACHE: Dict[Tuple[str, torch.dtype], Tuple[torch.Tensor, torch.Tensor]] = {}


def _get_loss_weight_tensors(device: torch.device, dtype: torch.dtype) -> Tuple[torch.Tensor, torch.Tensor]:
    key = (str(device), dtype)
    cached = _LOSS_TENSOR_CACHE.get(key)
    if cached is not None:
        return cached
    sens = torch.as_tensor(_ACOUSTIC_SENSITIVITY_26, device=device, dtype=dtype).view(1, 1, -1)
    area_w = torch.tensor([2.5, 1.2, 1.2, 1.2, 0.8, 1.8], device=device, dtype=dtype).view(1, 1, -1)
    _LOSS_TENSOR_CACHE[key] = (sens, area_w)
    return sens, area_w


def kf_trajectory_loss(
    x_hat: torch.Tensor,
    x_target: torch.Tensor,
    delta: torch.Tensor,
    w_mask: torch.Tensor,
    valid_mask: torch.Tensor,
    events: torch.Tensor,
    *,
    tube_proxy: Optional[TubeAreaProxy27] = None,
    w_vel: float = 4.0,
    w_acc: float = 12.0,
    w_delta_reg: float = 0.015,
    w_tube: float = 0.35,
    w_closure_guard: float = 0.50,
    closure_area_thresh_cm2: float = 0.04,
    vowel_open_floor_cm2: float = 0.14,
    return_metrics: bool = True,
) -> Tuple[torch.Tensor, Dict[str, float]]:
    """Composite parameter + kinematics + differentiable R21 tube-area guard loss.

    Args:
        x_hat      : (B, T, 26) predicted normalized controls
        x_target   : (B, T, 26) ground-truth / Stage-4 teacher normalized controls
        delta      : (B, T, 26) predicted residual
        w_mask     : (B, T, 26) organ constraint mask in [0, 1]
        valid_mask : (B, T) valid frame mask
        events     : (B, T, 4) [is_closure, is_release, is_aspiration, is_voiced]
    """
    dtype = torch.float32
    xh = x_hat.to(dtype)
    xt = x_target.to(dtype)
    dl = delta.to(dtype)
    wm = w_mask.to(dtype)
    vm = valid_mask.to(dtype)
    ev = events.to(dtype)

    sens, area_w = _get_loss_weight_tensors(xh.device, dtype)
    # Give core constrained channels (w -> 1) stronger emphasis (up to 2x) while still training free dims
    elem_w = vm.unsqueeze(-1) * sens * (1.0 + 1.0 * wm)
    denom = elem_w.sum().clamp(min=1.0)

    # 1. Weighted Smooth-L1 (robust against teacher inversion outliers)
    l_pos = (F.smooth_l1_loss(xh, xt, beta=0.05, reduction="none") * elem_w).sum() / denom

    # 2. First- and second-order kinematics (velocity & acceleration alignment)
    m1 = (vm[:, 1:] * vm[:, :-1]).unsqueeze(-1)
    d1_w = m1 * sens
    l_vel = (
        F.smooth_l1_loss(xh[:, 1:] - xh[:, :-1], xt[:, 1:] - xt[:, :-1], beta=0.03, reduction="none") * d1_w
    ).sum() / d1_w.sum().clamp(min=1.0)

    m2 = (vm[:, 2:] * vm[:, 1:-1] * vm[:, :-2]).unsqueeze(-1)
    d2_w = m2 * sens
    d2_h = xh[:, 2:] - 2.0 * xh[:, 1:-1] + xh[:, :-2]
    d2_t = xt[:, 2:] - 2.0 * xt[:, 1:-1] + xt[:, :-2]
    l_acc = (F.smooth_l1_loss(d2_h, d2_t, beta=0.02, reduction="none") * d2_w).sum() / d2_w.sum().clamp(min=1.0)

    # 3. Gentle residual shrinkage (prevents unnecessary drift away from physical baseline)
    l_dreg = ((dl ** 2) * vm.unsqueeze(-1)).sum() / (vm.sum() * KF_OUT_DIM).clamp(min=1.0)

    total = l_pos + w_vel * l_vel + w_acc * l_acc + w_delta_reg * l_dreg
    parts: Dict[str, float] = {}
    if return_metrics:
        parts = {
            "l_pos": float(l_pos.detach()),
            "l_vel": float(l_vel.detach()),
            "l_acc": float(l_acc.detach()),
            "l_dreg": float(l_dreg.detach()),
            "l_tube": 0.0,
            "l_guard": 0.0,
        }

    # 4. Frozen differentiable R21 tube-area & closure/spurious-constriction guard
    if tube_proxy is not None and (w_tube > 0.0 or w_closure_guard > 0.0):
        pred_log_a = tube_proxy(xh[..., :17])
        with torch.no_grad():
            tgt_log_a = tube_proxy(xt[..., :17])
        # Match 6-dim regional cross-sectional areas (extra weight on min_oral [0] and nasal_port [5])
        aw = vm.unsqueeze(-1) * area_w
        l_tube = (F.smooth_l1_loss(pred_log_a, tgt_log_a, beta=0.05, reduction="none") * aw).sum() / aw.sum().clamp(min=1.0)

        pred_min_oral = torch.expm1(pred_log_a[..., 0].clamp(max=6.0)).clamp(min=0.0)
        is_cl = ev[..., 0] * vm
        # During explicit stop closures: penalize air leakage (min_oral > closure_area_thresh)
        cl_pen = (F.relu(pred_min_oral - closure_area_thresh_cm2) * is_cl).sum() / is_cl.sum().clamp(min=1.0)
        # During open non-closure voiced frames where teacher was clearly open: prevent spurious closure
        with torch.no_grad():
            tgt_min_oral = torch.expm1(tgt_log_a[..., 0].clamp(max=6.0)).clamp(min=0.0)
            open_mask = (1.0 - ev[..., 0]) * (tgt_min_oral > vowel_open_floor_cm2 + 0.08).to(dtype) * vm
        open_pen = (F.relu(vowel_open_floor_cm2 - pred_min_oral) * open_mask).sum() / open_mask.sum().clamp(min=1.0)
        l_guard = cl_pen + open_pen

        total = total + w_tube * l_tube + w_closure_guard * l_guard
        if return_metrics:
            parts["l_tube"] = float(l_tube.detach())
            parts["l_guard"] = float(l_guard.detach())

    return total, parts


# Official unified model class aliases (backward-compatible)
Tract2AreaProxy = TubeAreaProxy27
IPA2TractLite = KeyframeTractModel27
IPA2Tract = KeyframeTractModel27

__all__ = [
    "IPA2Tract",
    "IPA2TractLite",
    "KeyframeTractModel27",
    "TUBE_PROXY_DIM",
    "TUBE_PROXY_NAMES",
    "Tract2AreaProxy",
    "TubeAreaProxy27",
    "export_kf_fp16_weights",
    "export_kf_model_onnx",
    "kf_trajectory_loss",
]
