"""Text2Prosody-Lite: Zero-backbone bilingual (Zh/En/Mixed-IPA) Duration, Semitone-F0 & Pause predictor.

Takes phone-level universal articulatory + prosodic structural features (shared seamlessly across
Mandarin, English, code-switched sentences, and inline [IPA]) and predicts:
  1. `log_dur`   : log(dur_ms / 80.0) per phone
  2. `f0_st3`    : [start, mid, end] relative semitone F0 contour per phone (speaker-independent)
  3. `voiced_lgt`: voiced F0 presence logit per phone
  4. `pause_lgt` / `log_pause_dur`: natural post-phone pause gate & duration at prosodic boundaries

Architecture: 4-layer Conformer (d=128) + 1-layer BiGRU (~1.15M params, FP16 ~2.3 MB, INT8 ~1.2 MB,
pure CPU < 3 ms/utterance). Exports cleanly via `tt3.browser_m27_models` FP16/INT8 helpers.
"""
from __future__ import annotations

from typing import Any, Dict, Optional, Tuple

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

from .models import ConformerBlock

# ---------------------------------------------------------------------------
# Shared Feature & Token Constants (bit-identical across train & kf_ipa_synth)
# ---------------------------------------------------------------------------
LANG_SIL = 0
LANG_ZH = 1
LANG_EN = 2
LANG_IPA = 3
NUM_LANGS = 4

TONE_NONE = 0
TONE_ZH_1 = 1       # 55 high level
TONE_ZH_2 = 2       # 35 rising
TONE_ZH_3 = 3       # 214 dipping / citation
TONE_ZH_4 = 4       # 51 falling
TONE_ZH_5 = 5       # 0 neutral
TONE_ZH_HALF3 = 6   # 21 half-third sandhi
STRESS_EN_1 = 7     # English primary stress
STRESS_EN_2 = 8     # English secondary stress
STRESS_EN_0 = 9     # English unstressed
NUM_TONE_STRESS = 10

PUNCT_NONE = 0
PUNCT_COMMA = 1     # minor break / comma / %
PUNCT_PERIOD = 2    # major break / period / $
PUNCT_QUESTION = 3  # question ?
PUNCT_EXCLAIM = 4   # exclamation !
NUM_PUNCTS = 5

ROLE_NORMAL = 0
ROLE_CLOSURE = 1
ROLE_RELEASE = 2
ROLE_SIL = 3
NUM_ROLES = 4

PHON_FEAT_DIM = 22
POS_STRUCT_DIM = 10
DUR_REF_MS = 80.0
PAUSE_REF_MS = 120.0
ST_CLAMP_MIN = -14.0
ST_CLAMP_MAX = 16.0


def hz_to_semitone_rel(f0_hz: np.ndarray, base_hz: float) -> np.ndarray:
    """Convert Hz array to semitones relative to `base_hz`."""
    safe_base = max(40.0, float(base_hz))
    safe_f0 = np.maximum(40.0, np.asarray(f0_hz, dtype=np.float64))
    st = 12.0 * np.log2(safe_f0 / safe_base)
    return np.clip(st, ST_CLAMP_MIN, ST_CLAMP_MAX).astype(np.float32)


def semitone_rel_to_hz(st: np.ndarray, base_hz: float) -> np.ndarray:
    """Convert relative semitones back to Hz anchored at `base_hz`."""
    safe_base = max(40.0, float(base_hz))
    st_c = np.clip(np.asarray(st, dtype=np.float64), ST_CLAMP_MIN, ST_CLAMP_MAX)
    return np.clip(safe_base * (2.0 ** (st_c / 12.0)), 50.0, 550.0).astype(np.float32)


class Text2ProsodyLite(nn.Module):
    """Lightweight Conformer-BiGRU phone-level prosody (duration + 3-pt semitone F0 + pause) predictor."""

    def __init__(
        self,
        hidden_dim: int = 128,
        num_layers: int = 4,
        num_heads: int = 4,
        conv_kernel_size: int = 7,
        dropout: float = 0.1,
    ) -> None:
        super().__init__()
        self.hidden_dim = int(hidden_dim)
        self.num_layers = int(num_layers)
        self.num_heads = int(num_heads)
        self.conv_kernel_size = int(conv_kernel_size)
        self.dropout = float(dropout)

        self.lang_emb = nn.Embedding(NUM_LANGS, 16)
        self.tone_emb = nn.Embedding(NUM_TONE_STRESS, 24)
        self.punct_emb = nn.Embedding(NUM_PUNCTS, 16)
        self.role_emb = nn.Embedding(NUM_ROLES, 8)

        in_dim = PHON_FEAT_DIM + POS_STRUCT_DIM + 16 + 24 + 16 + 8  # 96
        self.in_proj = nn.Sequential(
            nn.Linear(in_dim, self.hidden_dim),
            nn.LayerNorm(self.hidden_dim),
            nn.GELU(),
        )
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
        self.gru = nn.GRU(
            input_size=self.hidden_dim,
            hidden_size=self.hidden_dim // 2,
            num_layers=1,
            batch_first=True,
            bidirectional=True,
        )
        self.out_norm = nn.LayerNorm(self.hidden_dim)

        # Head 1: Phone duration in log(dur_ms / 80.0)
        self.dur_head = nn.Sequential(
            nn.Linear(self.hidden_dim, self.hidden_dim // 2),
            nn.GELU(),
            nn.Linear(self.hidden_dim // 2, 1),
        )

        # Head 2: Pause gate & log pause duration after phone (for phrase boundaries)
        self.pause_head = nn.Sequential(
            nn.Linear(self.hidden_dim + 1, self.hidden_dim // 2),
            nn.GELU(),
            nn.Linear(self.hidden_dim // 2, 2),  # [pause_logit, log_pause_dur]
        )

        # Head 3: 3-point relative semitone F0 [start, mid, end] + voiced logit (conditioned on pred log_dur)
        self.f0_head = nn.Sequential(
            nn.Linear(self.hidden_dim + 1, self.hidden_dim),
            nn.GELU(),
            nn.Dropout(self.dropout * 0.5),
            nn.Linear(self.hidden_dim, 4),  # [st_start, st_mid, st_end, voiced_logit]
        )

    def get_arch_config(self) -> Dict[str, Any]:
        return {
            "hidden_dim": self.hidden_dim,
            "num_layers": self.num_layers,
            "num_heads": self.num_heads,
            "conv_kernel_size": self.conv_kernel_size,
            "dropout": self.dropout,
        }

    @classmethod
    def from_arch_config(cls, cfg: Optional[Dict[str, Any]]) -> "Text2ProsodyLite":
        c = dict(cfg or {})
        return cls(
            hidden_dim=int(c.get("hidden_dim", 128)),
            num_layers=int(c.get("num_layers", 4)),
            num_heads=int(c.get("num_heads", 4)),
            conv_kernel_size=int(c.get("conv_kernel_size", 7)),
            dropout=float(c.get("dropout", 0.1)),
        )

    def count_parameters(self) -> int:
        return sum(p.numel() for p in self.parameters())

    def forward(
        self,
        phon_feat: torch.Tensor,      # (B, L, 22)
        pos_struct: torch.Tensor,     # (B, L, 10)
        lang_id: torch.Tensor,        # (B, L) long
        tone_stress_id: torch.Tensor, # (B, L) long
        punct_id: torch.Tensor,       # (B, L) long
        role_id: torch.Tensor,        # (B, L) long
        valid_mask: torch.Tensor,     # (B, L) float 0/1
        gt_log_dur: Optional[torch.Tensor] = None,  # optional teacher forcing during training
    ) -> Dict[str, torch.Tensor]:
        x = torch.cat(
            [
                phon_feat.float(),
                pos_struct.float(),
                self.lang_emb(lang_id.long().clamp(0, NUM_LANGS - 1)),
                self.tone_emb(tone_stress_id.long().clamp(0, NUM_TONE_STRESS - 1)),
                self.punct_emb(punct_id.long().clamp(0, NUM_PUNCTS - 1)),
                self.role_emb(role_id.long().clamp(0, NUM_ROLES - 1)),
            ],
            dim=-1,
        )
        h = self.in_proj(x)
        vm = valid_mask.float()
        for blk in self.blocks:
            h = blk(h, vm)

        # Packed BiGRU for clean zero-padding boundary handling
        lengths = vm.sum(dim=1).long().clamp(min=1).cpu()
        packed = nn.utils.rnn.pack_padded_sequence(h, lengths, batch_first=True, enforce_sorted=False)
        gru_out, _ = self.gru(packed)
        gru_out, _ = nn.utils.rnn.pad_packed_sequence(gru_out, batch_first=True, total_length=h.shape[1])
        h = self.out_norm(h + gru_out) * vm.unsqueeze(-1)

        log_dur = self.dur_head(h).squeeze(-1)  # (B, L)
        dur_cond = (gt_log_dur if gt_log_dur is not None else log_dur.detach()).unsqueeze(-1)

        p_out = self.pause_head(torch.cat([h, dur_cond], dim=-1))
        f_out = self.f0_head(torch.cat([h, dur_cond], dim=-1))

        return {
            "log_dur": log_dur,                  # (B, L)
            "f0_st3": f_out[..., :3],            # (B, L, 3)
            "voiced_logit": f_out[..., 3],       # (B, L)
            "pause_logit": p_out[..., 0],        # (B, L)
            "log_pause_dur": p_out[..., 1],      # (B, L)
        }


__all__ = [
    "DUR_REF_MS",
    "LANG_EN",
    "LANG_IPA",
    "LANG_SIL",
    "LANG_ZH",
    "NUM_LANGS",
    "NUM_PUNCTS",
    "NUM_ROLES",
    "NUM_TONE_STRESS",
    "PAUSE_REF_MS",
    "PHON_FEAT_DIM",
    "POS_STRUCT_DIM",
    "PUNCT_COMMA",
    "PUNCT_EXCLAIM",
    "PUNCT_NONE",
    "PUNCT_PERIOD",
    "PUNCT_QUESTION",
    "ROLE_CLOSURE",
    "ROLE_NORMAL",
    "ROLE_RELEASE",
    "ROLE_SIL",
    "STRESS_EN_0",
    "STRESS_EN_1",
    "STRESS_EN_2",
    "TONE_NONE",
    "TONE_ZH_1",
    "TONE_ZH_2",
    "TONE_ZH_3",
    "TONE_ZH_4",
    "TONE_ZH_5",
    "TONE_ZH_HALF3",
    "Text2ProsodyLite",
    "hz_to_semitone_rel",
    "semitone_rel_to_hz",
]
