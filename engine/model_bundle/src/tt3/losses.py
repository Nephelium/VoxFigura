"""Loss functions for TensorTract3 (ESSV 2026 Eq. 1 & smoothness regularization)."""
from __future__ import annotations

from typing import Dict, Tuple

import torch
import torch.nn.functional as F


def _masked_mse(pred: torch.Tensor, target: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
    # pred, target: (B, T, D); mask: (B, T)
    sq = (pred - target) ** 2
    m = mask.unsqueeze(-1).to(sq.dtype)
    denom = (m.sum() * pred.shape[-1]).clamp(min=1.0)
    return (sq * m).sum() / denom


def pressure_loss(
    pr_hat: torch.Tensor,
    pr_target: torch.Tensor,
    valid_mask: torch.Tensor,
) -> Tuple[torch.Tensor, Dict[str, float]]:
    """PR-Encoder 损失：数值 L2 + 一阶导数 L2。"""
    l0 = _masked_mse(pr_hat, pr_target, valid_mask)
    m1 = valid_mask[:, 1:] * valid_mask[:, :-1]
    l1 = _masked_mse(pr_hat[:, 1:] - pr_hat[:, :-1], pr_target[:, 1:] - pr_target[:, :-1], m1)
    total = l0 + 2.0 * l1
    return total, {"l0": float(l0.detach()), "l1": float(l1.detach())}


def motor_domain_loss(
    m20_hat: torch.Tensor,
    m20_target: torch.Tensor,
    valid_mask: torch.Tensor,
    *,
    beta0: float = 1.0,
    beta1: float = 10.0,
    beta2: float = 100.0,
) -> Tuple[torch.Tensor, Dict[str, float]]:
    """ESSV 2026 Eq. (1) 构音参数域损失：L_M + 10*L_d1 + 100*L_d2。"""
    l0 = _masked_mse(m20_hat, m20_target, valid_mask)

    m1 = valid_mask[:, 1:] * valid_mask[:, :-1]
    d1_hat = m20_hat[:, 1:] - m20_hat[:, :-1]
    d1_tgt = m20_target[:, 1:] - m20_target[:, :-1]
    l1 = _masked_mse(d1_hat, d1_tgt, m1)

    m2 = valid_mask[:, 2:] * valid_mask[:, 1:-1] * valid_mask[:, :-2]
    d2_hat = m20_hat[:, 2:] - 2.0 * m20_hat[:, 1:-1] + m20_hat[:, :-2]
    d2_tgt = m20_target[:, 2:] - 2.0 * m20_target[:, 1:-1] + m20_target[:, :-2]
    l2 = _masked_mse(d2_hat, d2_tgt, m2)

    total = beta0 * l0 + beta1 * l1 + beta2 * l2
    return total, {"l_m": float(l0.detach()), "l_d1": float(l1.detach()), "l_d2": float(l2.detach())}


def wavlm_acoustic_loss(
    w_hat: torch.Tensor,
    w_target: torch.Tensor,
    valid_mask: torch.Tensor,
) -> torch.Tensor:
    """WavLM 特征空间 L2 声学损失 L_W。"""
    return _masked_mse(w_hat, w_target, valid_mask)


def natural_smooth_regularization(
    m20_hat: torch.Tensor,
    valid_mask: torch.Tensor,
    *,
    w_d1: float = 0.05,
    w_d2: float = 0.25,
    w_clip: float = 0.05,
) -> Tuple[torch.Tensor, Dict[str, float]]:
    """抑制纯自然语音续训中反演器钻解码器漏洞导致的切幅或高频颤动（论文 §4.1）。"""
    m1 = valid_mask[:, 1:] * valid_mask[:, :-1]
    d1 = m20_hat[:, 1:] - m20_hat[:, :-1]
    zero1 = torch.zeros_like(d1)
    l_d1 = _masked_mse(d1, zero1, m1)

    m2 = valid_mask[:, 2:] * valid_mask[:, 1:-1] * valid_mask[:, :-2]
    d2 = m20_hat[:, 2:] - 2.0 * m20_hat[:, 1:-1] + m20_hat[:, :-2]
    zero2 = torch.zeros_like(d2)
    l_d2 = _masked_mse(d2, zero2, m2)

    # 温和惩罚接近 tanh 极值 [-0.96, 0.96] 之外的边界饱和
    excess = F.relu(torch.abs(m20_hat) - 0.96)
    l_clip = _masked_mse(excess, torch.zeros_like(excess), valid_mask)

    reg = w_d1 * l_d1 + w_d2 * l_d2 + w_clip * l_clip
    return reg, {
        "reg_d1": float(l_d1.detach()),
        "reg_d2": float(l_d2.detach()),
        "reg_clip": float(l_clip.detach()),
    }
