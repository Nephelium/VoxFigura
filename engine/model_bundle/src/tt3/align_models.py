"""Vox2Align-Lite: Zero-backbone bilingual (Mandarin + English + Code-Switch) Phone & Syllable Alignment Head.

Attaches directly onto the frozen `Vox2Tract-Lite` (`BrowserLightM27Inverter`) acoustic backbone:
  - Input per 50 Hz frame (20 ms): `[h_backbone (192-d), m27_norm (27-d)] = 219-d`
    (zero extra backbone weights, zero WavLM, zero MFA runtime!)
  - ~1.07M params (FP16 ~2.1 MB, INT8 ~1.1 MB), ~4 ms extra CPU time per utterance.
  - 6 jointly trained 50 Hz heads:
      1. `phone_frame_logits` (63): frame-level unified Zh+En IPA posteriors (sharp 20 ms boundaries)
      2. `phone_ctc_logits`   (63): dedicated CTC branch (monotone sequence robustness)
      3. `boundary_logits`    (2):  [phone_boundary, syllable_boundary] probabilities
      4. `speech_mask_logit`  (1):  active articulation / speech gate to silence phantom tongue drift
      5. `tone_logits`        (8):  0=sil/none, 1..5=Mandarin Tone 1..5, 6=EN unstressed, 7=EN stressed
      6. `lang_logits`        (3):  0=sil, 1=Mandarin, 2=English
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np
import torch
import torch.nn as nn

from .models import ConvNeXtBlock1D

# ---------------------------------------------------------------------------
# Unified Bilingual Zh + En IPA Vocabulary (63 canonical tokens)
# ---------------------------------------------------------------------------
ALIGN_BLANK_ID = 0
ALIGN_SIL_ID = 1

ALIGN_VOCAB: Tuple[str, ...] = (
    "<blank>",
    "sil",
    # Consonants & Glides (38)
    "p", "pʰ", "b",
    "t", "tʰ", "d",
    "k", "kʰ", "ɡ",
    "f", "v", "θ", "ð",
    "s", "z", "ʂ", "ʐ", "ʃ", "ʒ", "ɕ", "x", "h",
    "ts", "tsʰ", "tʂ", "tʂʰ", "tʃ", "dʒ", "tɕ", "tɕʰ",
    "m", "n", "ŋ",
    "l", "ɹ", "j", "w", "ɥ",
    # Vowels & Diphthongs (23)
    "a", "ɑ", "æ", "ʌ",
    "e", "ɛ", "ə", "ɚ", "ɝ",
    "i", "ɪ",
    "o", "ɔ",
    "u", "ʊ", "y",
    "ɿ", "ʅ",
    "aɪ", "aʊ", "eɪ", "oʊ", "ɔɪ",
)
ALIGN_VOCAB_SIZE = len(ALIGN_VOCAB)  # 63
ALIGN_IPA_TO_ID: Dict[str, int] = {sym: idx for idx, sym in enumerate(ALIGN_VOCAB)}

ALIGN_VOWEL_SET = frozenset({
    "a", "ɑ", "æ", "ʌ", "e", "ɛ", "ə", "ɚ", "ɝ",
    "i", "ɪ", "o", "ɔ", "u", "ʊ", "y", "ɿ", "ʅ",
    "aɪ", "aʊ", "eɪ", "oʊ", "ɔɪ",
})
ALIGN_STOP_OR_GLIDE_SET = frozenset({
    "p", "pʰ", "b", "t", "tʰ", "d", "k", "kʰ", "ɡ",
    "j", "w", "ɥ",
})

# Tone / stress classes (8)
ATONE_NONE = 0
ATONE_ZH_1 = 1
ATONE_ZH_2 = 2
ATONE_ZH_3 = 3
ATONE_ZH_4 = 4
ATONE_ZH_5 = 5
ATONE_EN_0 = 6
ATONE_EN_1 = 7
ALIGN_NUM_TONES = 8

# Language classes (3)
ALANG_SIL = 0
ALANG_ZH = 1
ALANG_EN = 2
ALIGN_NUM_LANGS = 3

# Normalization tables for Zh & En inputs so AISHELL-3 MFA, TIMIT, Expresso, webedit,
# and `text2ipa.py` map cleanly with 0% OOV into `ALIGN_VOCAB`.
_EN_ALIAS = {
    "g": "ɡ", "r": "ɹ", "ɜ": "ɝ", "ɚ": "ɝ",
    "ɨ": "ɪ", "ʉ": "u", "ɦ": "h",
    "ɾ": "t", "ʔ": "t", "ɾ̃": "n", "ə̥": "ə",
    "e": "eɪ", "o": "oʊ", "ɒ": "ɔ", "a": "ɑ",
}
_ZH_ALIAS = {
    "ɤ": "ə", "ɑ": "a", "ɛ": "e", "ʊ": "u", "ɪ": "i",
    "ɡ": "k", "g": "k", "h": "x", "r": "ʐ", "ɹ": "ʐ",
    "ʈʂ": "tʂ", "ʈʂʰ": "tʂʰ", "z̩": "ɿ", "ʐ̩": "ʅ",
    "aj": "aɪ", "aw": "aʊ", "ej": "eɪ", "ow": "oʊ",
    "io": "o", "ŋ̍": "ŋ", "ɻ": "ɚ",
    "ʮ": "ɿ", "ʯ": "ʅ", "ɜ": "ə", "ʌ": "ə",
}


def normalize_align_ipa(ipa: str, lang: str = "auto") -> str:
    """Map an arbitrary IPA phone from MFA / TIMIT / webedit / text2ipa into `ALIGN_VOCAB`."""
    s = (ipa or "").strip().replace("͡", "").replace("͜", "")
    if not s or s in ("sil", "sp", "pau", "h#", "epi", "ʔ", "<unk>", "spn"):
        return "sil"
    # Strip Chao tone letters & length/syllabic marks
    s = "".join(ch for ch in s if ch not in "˥˦˧˨˩ːˑ̩̥̯̃̚")
    if not s:
        return "sil"
    lg = (lang or "auto").lower()
    if lg.startswith("zh"):
        s = _ZH_ALIAS.get(s, s)
        if s in ALIGN_IPA_TO_ID:
            return s
        s2 = s.replace("ʰ", "")
        return _ZH_ALIAS.get(s2, s2) if _ZH_ALIAS.get(s2, s2) in ALIGN_IPA_TO_ID else "sil"
    if lg.startswith("en"):
        s = s.replace("ʰ", "")
        s = _EN_ALIAS.get(s, s)
        return s if s in ALIGN_IPA_TO_ID else "sil"
    # Auto fallback
    if s in ALIGN_IPA_TO_ID:
        return s
    for tbl in (_ZH_ALIAS, _EN_ALIAS):
        if s in tbl and tbl[s] in ALIGN_IPA_TO_ID:
            return tbl[s]
    s2 = s.replace("ʰ", "")
    if s2 in ALIGN_IPA_TO_ID:
        return s2
    return "sil"


def pack_m27_norm(
    tract17: torch.Tensor,
    f0_norm: torch.Tensor,
    pr1: torch.Tensor,
    glot8: torch.Tensor,
) -> torch.Tensor:
    """Assemble exact 27-dim M27 normalized tensor `[tract17(0..16), F0(17), PR(18), glot8(19..26)]`."""
    f0_col = f0_norm.unsqueeze(-1) if f0_norm.ndim == 2 else f0_norm
    return torch.cat([tract17, f0_col.to(tract17.dtype), pr1, glot8], dim=-1)


def _run_masked_bigru(gru: nn.GRU, x: torch.Tensor, valid_mask: Optional[torch.Tensor]) -> torch.Tensor:
    if valid_mask is None:
        out, _ = gru(x)
        return out
    lengths = valid_mask.long().sum(dim=1).clamp(min=1).cpu()
    packed = nn.utils.rnn.pack_padded_sequence(x, lengths, batch_first=True, enforce_sorted=False)
    out_packed, _ = gru(packed)
    out, _ = nn.utils.rnn.pad_packed_sequence(out_packed, batch_first=True, total_length=x.shape[1])
    return out * valid_mask.unsqueeze(-1).to(out.dtype)


class Vox2AlignLite(nn.Module):
    """Lightweight bilingual phone/syllable/tone/speech-mask head over frozen `Vox2Tract-Lite` features."""

    def __init__(
        self,
        backbone_dim: int = 192,
        m27_dim: int = 27,
        hidden_dim: int = 192,
        conv_blocks: int = 2,
        conv_kernel_size: int = 9,
        gru_hidden: int = 128,
        gru_layers: int = 2,
        vocab_size: int = ALIGN_VOCAB_SIZE,
        num_tones: int = ALIGN_NUM_TONES,
        num_langs: int = ALIGN_NUM_LANGS,
        dropout: float = 0.10,
    ) -> None:
        super().__init__()
        self.backbone_dim = int(backbone_dim)
        self.m27_dim = int(m27_dim)
        self.in_dim = self.backbone_dim + self.m27_dim
        self.hidden_dim = int(hidden_dim)
        self.conv_blocks_n = int(conv_blocks)
        self.conv_kernel_size = int(conv_kernel_size)
        self.gru_hidden = int(gru_hidden)
        self.gru_layers = int(gru_layers)
        self.vocab_size = int(vocab_size)
        self.num_tones = int(num_tones)
        self.num_langs = int(num_langs)
        self.dropout = float(dropout)

        self.in_proj = nn.Sequential(
            nn.Linear(self.in_dim, self.hidden_dim),
            nn.LayerNorm(self.hidden_dim),
            nn.GELU(),
        )
        self.conv_blocks = nn.ModuleList(
            [
                ConvNeXtBlock1D(dim=self.hidden_dim, expansion=3, kernel_size=self.conv_kernel_size)
                for _ in range(self.conv_blocks_n)
            ]
        )
        self.bigru = nn.GRU(
            input_size=self.hidden_dim,
            hidden_size=self.gru_hidden,
            num_layers=self.gru_layers,
            batch_first=True,
            bidirectional=True,
            dropout=self.dropout if self.gru_layers > 1 else 0.0,
        )
        ctx_dim = self.gru_hidden * 2
        self.out_norm = nn.LayerNorm(ctx_dim)
        self.drop = nn.Dropout(self.dropout)

        # Decoupled heads
        self.phone_frame_head = nn.Linear(ctx_dim, self.vocab_size)
        self.phone_ctc_head = nn.Linear(ctx_dim, self.vocab_size)
        self.boundary_head = nn.Linear(ctx_dim, 2)      # [phone_bnd, syl_bnd]
        self.speech_mask_head = nn.Linear(ctx_dim, 1)   # active articulation / speech mask
        self.tone_head = nn.Linear(ctx_dim, self.num_tones)
        self.lang_head = nn.Linear(ctx_dim, self.num_langs)

    def get_arch_config(self) -> Dict[str, Any]:
        return {
            "backbone_dim": self.backbone_dim,
            "m27_dim": self.m27_dim,
            "hidden_dim": self.hidden_dim,
            "conv_blocks": self.conv_blocks_n,
            "conv_kernel_size": self.conv_kernel_size,
            "gru_hidden": self.gru_hidden,
            "gru_layers": self.gru_layers,
            "vocab_size": self.vocab_size,
            "num_tones": self.num_tones,
            "num_langs": self.num_langs,
            "dropout": self.dropout,
            "vocab": list(ALIGN_VOCAB),
        }

    @classmethod
    def from_arch_config(cls, cfg: Optional[Dict[str, Any]]) -> "Vox2AlignLite":
        if not cfg:
            return cls()
        keys = (
            "backbone_dim", "m27_dim", "hidden_dim", "conv_blocks", "conv_kernel_size",
            "gru_hidden", "gru_layers", "vocab_size", "num_tones", "num_langs", "dropout",
        )
        return cls(**{k: cfg[k] for k in keys if k in cfg})

    def count_parameters(self) -> int:
        return sum(p.numel() for p in self.parameters())

    def forward(
        self,
        h_backbone: torch.Tensor,
        m27_norm: torch.Tensor,
        valid_mask: Optional[torch.Tensor] = None,
    ) -> Dict[str, torch.Tensor]:
        """
        Args:
            h_backbone: (B, T, 192) frozen Conformer features from `Vox2Tract-Lite`
            m27_norm:   (B, T, 27)  normalized M27 trajectory from `Vox2Tract-Lite`
            valid_mask: optional (B, T) float/bool mask
        """
        x = torch.cat([h_backbone, m27_norm.to(h_backbone.dtype)], dim=-1)
        x = self.in_proj(x)
        if valid_mask is not None:
            m = valid_mask.unsqueeze(-1).to(x.dtype)
            x = x * m
        for blk in self.conv_blocks:
            x = blk(x)
            if valid_mask is not None:
                x = x * m

        h = _run_masked_bigru(self.bigru, x, valid_mask)
        h = self.drop(self.out_norm(h))
        if valid_mask is not None:
            h = h * valid_mask.unsqueeze(-1).to(h.dtype)

        return {
            "phone_frame_logits": self.phone_frame_head(h),     # (B, T, 63)
            "phone_ctc_logits": self.phone_ctc_head(h),         # (B, T, 63)
            "boundary_logits": self.boundary_head(h),           # (B, T, 2)
            "speech_mask_logit": self.speech_mask_head(h).squeeze(-1),  # (B, T)
            "tone_logits": self.tone_head(h),                   # (B, T, 8)
            "lang_logits": self.lang_head(h),                   # (B, T, 3)
        }


# ---------------------------------------------------------------------------
# Fast NumPy Post-Processing: Speech Mask, Forced Alignment & Blind Decoding
# ---------------------------------------------------------------------------

# Quiet physiological rest vocal tract pose in physical M27 units
# M27 indices: 0..16 tract17 [HX, HY, JX, JA, LP, LD, VS, VO, TCX, TCY, TTX, TTY, TBX, TBY, TS1, TS2, TS3],
# 17=F0, 18=PR, 19..26 glot8 [XB, XT, CA, LAG, RA, PS, FL, SHIM]
REST_M27_PHYS = np.array(
    [
        1.0, -4.75, 0.0, -2.5, -0.05, 0.55, 0.0, -0.08,   # HX..VO (relaxed neutral lips & velum)
        -0.4, -0.8, 1.8, -1.6, 0.5, -0.8, 0.15, 0.05, 0.0,  # TCX..TS3 (neutral resting tongue; TS1/TS2 in [0, 1])
        130.0,  # F0 (unused during silence, kept continuous)
        0.0,    # PR = 0 dPa
        0.0,    # XB
        0.0,    # XT
        0.12,   # CA (gentle quiet breathing aperture)
        0.0,    # LAG
        0.0,    # RA = 0 (no glottal pulsing)
        0.0,    # DCH
        0.0,    # FL
        0.0,    # SHIM
    ],
    dtype=np.float32,
)


def apply_speech_mask_to_m27(
    m27_phys: np.ndarray,
    speech_prob: np.ndarray,
    *,
    threshold: float = 0.42,
    ramp_frames: int = 2,
    rest_pose: Optional[np.ndarray] = None,
) -> Tuple[np.ndarray, np.ndarray]:
    """Smoothly gate vocal-tract trajectory during non-speech silence to eliminate phantom tongue drift.

    Returns `(m27_masked, smooth_gate_50hz)`. Preserves F0 continuity (`col 17`) so downstream
    vocoder oscillators never glitch while relaxing tongue/jaw/lips/PR/RA cleanly in silence.
    """
    arr = np.asarray(m27_phys, dtype=np.float32).copy()
    p = np.asarray(speech_prob, dtype=np.float32).reshape(-1)
    T = min(arr.shape[0], p.shape[0])
    if T == 0:
        return arr, p

    # Soft-knee gate: frames with p <= 0.22 cleanly go to 0.0 (zero phantom tongue drift in silence),
    # while active speech (>= 0.50) stays 1.0 with a smooth 40 ms raised-cosine ramp at speech edges.
    soft = np.clip((p[:T] - 0.22) / max(0.05, float(threshold) - 0.14), 0.0, 1.0).astype(np.float32)
    if ramp_frames > 0 and T > 2:
        k = int(ramp_frames)
        win = np.hanning(2 * k + 3)[1:-1].astype(np.float32)
        win /= np.maximum(win.sum(), 1e-6)
        gate = np.convolve(np.pad(soft, (k, k), mode="edge"), win, mode="valid")
        # Keep true deep silence strictly quiet after smoothing
        gate = np.where(p[:T] < 0.15, gate * 0.25, gate)
        gate = np.clip(gate, 0.0, 1.0).astype(np.float32)
    else:
        gate = soft

    rest = REST_M27_PHYS if rest_pose is None else np.asarray(rest_pose, dtype=np.float32)
    g_col = gate[:, None]
    # Blend tract (0..16) and pressure/glottis (18..26), keep F0 (17) intact
    arr[:T, :17] = g_col * arr[:T, :17] + (1.0 - g_col) * rest[None, :17]
    arr[:T, 18:] = g_col * arr[:T, 18:] + (1.0 - g_col) * rest[None, 18:]
    return arr, gate


def viterbi_hybrid_forced_align(
    frame_log_probs: np.ndarray,
    ctc_log_probs: np.ndarray,
    phone_bnd_probs: np.ndarray,
    target_phone_ids: Sequence[int],
    *,
    optional_sil_after: Optional[Sequence[bool]] = None,
    hop_sec: float = 0.02,
) -> Tuple[List[Tuple[float, float, int, float]], float]:
    """Zero-blank-lag Monotonic Frame+Boundary Viterbi Forced Alignment.

    Every frame is assigned strictly to a target phone or an optional `sil` slot (before/between/after
    words), eliminating CTC blank-spike boundary drift while snapping transitions onto predicted
    acoustic-articulatory boundary peaks (`phone_bnd_probs`).

    Returns:
      - spans: list of `(start_sec, end_sec, phone_id, mean_logp)` aligned 1-to-1 with `target_phone_ids`
      - mean_score: average per-frame alignment log-likelihood
    """
    T, V = frame_log_probs.shape
    N = len(target_phone_ids)
    if N == 0 or T == 0:
        return [], -99.0

    # Hybrid emission score (0.72 frame posterior + 0.28 CTC posterior; mask out <blank> cleanly)
    em = 0.72 * frame_log_probs.astype(np.float64) + 0.28 * ctc_log_probs.astype(np.float64)
    b_log = np.log(np.clip(phone_bnd_probs.astype(np.float64), 1e-4, 1.0))
    nb_log = np.log(np.clip(1.0 - phone_bnd_probs.astype(np.float64), 1e-4, 1.0))

    # Build state graph: [sil_0, p_0, (opt_sil_1), p_1, ..., p_{N-1}, sil_end]
    states_pid: List[int] = [ALIGN_SIL_ID]
    states_phone_idx: List[int] = [-1]  # >=0 means target phone index, -1 means optional sil
    for idx, pid in enumerate(target_phone_ids):
        states_pid.append(int(pid))
        states_phone_idx.append(idx)
        allow_sil = (idx == N - 1) or (optional_sil_after is not None and idx < len(optional_sil_after) and optional_sil_after[idx])
        if allow_sil:
            states_pid.append(ALIGN_SIL_ID)
            states_phone_idx.append(-1)

    S = len(states_pid)
    st_pid = np.asarray(states_pid, dtype=np.int32)
    is_sil_state = np.asarray([p_idx < 0 for p_idx in states_phone_idx], dtype=bool)
    # Allowed skip-over-sil: from phone state s, you can step to s+1 (sil) OR skip directly to s+2 (next phone)
    can_skip = np.zeros(S, dtype=bool)
    for s in range(2, S):
        if is_sil_state[s - 1] and not is_sil_state[s]:
            can_skip[s] = True

    neg_inf = -1e18
    dp = np.full((T, S), neg_inf, dtype=np.float64)
    bp = np.zeros((T, S), dtype=np.int32)

    # Frame 0 can start in initial sil (0) or directly in phone 0 (1)
    dp[0, 0] = em[0, ALIGN_SIL_ID]
    if S > 1:
        dp[0, 1] = em[0, st_pid[1]]

    s_idx = np.arange(S, dtype=np.int32)
    w_bnd = 0.28
    # Small stay preference on interior non-sil to prevent 1-frame chatter, tiny sil cost to avoid false sil
    sil_pen = np.where(is_sil_state, -0.08, 0.0)

    for t in range(1, T):
        prev = dp[t - 1]
        # Stay in same state s: prefer non-boundary frame
        stay = prev + w_bnd * nb_log[t]
        # Step from s-1 -> s: reward boundary peak
        step1 = np.full(S, neg_inf, dtype=np.float64)
        step1[1:] = prev[:-1] + w_bnd * b_log[t]
        # Skip optional sil from s-2 -> s: reward boundary peak
        step2 = np.full(S, neg_inf, dtype=np.float64)
        if S > 2:
            step2[2:] = np.where(can_skip[2:], prev[:-2] + w_bnd * b_log[t], neg_inf)

        best = stay.copy()
        choice = s_idx.copy()
        m1 = step1 > best
        best = np.where(m1, step1, best)
        choice = np.where(m1, s_idx - 1, choice)
        m2 = step2 > best
        best = np.where(m2, step2, best)
        choice = np.where(m2, s_idx - 2, choice)

        dp[t] = best + em[t, st_pid] + sil_pen
        bp[t] = choice

    # End in final sil (S-1) or last phone (S-2)
    end_cands = [S - 1]
    if S >= 2 and is_sil_state[S - 1]:
        end_cands.append(S - 2)
    cur = max(end_cands, key=lambda c: dp[T - 1, c])
    total_score = float(dp[T - 1, cur])

    path = np.zeros(T, dtype=np.int32)
    path[T - 1] = cur
    for t in range(T - 1, 0, -1):
        cur = int(bp[t, cur])
        path[t - 1] = cur

    # Collect exact frame span per target phone index
    spans_by_idx: Dict[int, List[int]] = {}
    for t in range(T):
        p_idx = states_phone_idx[int(path[t])]
        if p_idx >= 0:
            spans_by_idx.setdefault(p_idx, []).append(t)

    out_spans: List[Tuple[float, float, int, float]] = []
    last_end = 0.0
    for idx, pid in enumerate(target_phone_ids):
        frames = spans_by_idx.get(idx)
        if frames:
            t0, t1 = frames[0], frames[-1] + 1
            sc = float(np.mean(em[frames, int(pid)]))
            s_sec = t0 * hop_sec
            e_sec = t1 * hop_sec
            last_end = e_sec
            out_spans.append((s_sec, e_sec, int(pid), sc))
        else:
            # Degenerate ultra-short fallback (guarantees 1-to-1 length)
            s_sec = last_end
            e_sec = min(T * hop_sec, last_end + hop_sec)
            last_end = e_sec
            out_spans.append((s_sec, e_sec, int(pid), -5.0))
    return out_spans, total_score / float(max(1, T))


def blind_decode_phones(
    frame_log_probs: np.ndarray,
    phone_bnd_probs: np.ndarray,
    syl_bnd_probs: np.ndarray,
    speech_probs: np.ndarray,
    tone_probs: np.ndarray,
    lang_probs: np.ndarray,
    *,
    hop_sec: float = 0.02,
    switch_penalty: float = 1.15,
    min_sil_frames: int = 2,
) -> List[Dict[str, Any]]:
    """Zero-text bilingual phone decoder using smooth boundary-aware HMM Viterbi over frame posteriors.

    Produces clean, non-flickering phone segments with per-phone confidence, tone, language,
    and whether a syllable boundary occurs at the segment onset.
    """
    T, V = frame_log_probs.shape
    if T == 0:
        return []

    # Mask <blank> out of frame decoding; gate non-speech frames gently toward `sil`
    em = frame_log_probs.astype(np.float64).copy()
    em[:, ALIGN_BLANK_ID] = -1e9
    sil_boost = np.log(np.clip(1.0 - speech_probs.astype(np.float64), 1e-4, 1.0)) * 0.35
    sp_boost = np.log(np.clip(speech_probs.astype(np.float64), 1e-4, 1.0)) * 0.35
    em[:, ALIGN_SIL_ID] += sil_boost
    em[:, 2:] += sp_boost[:, None]

    # Dynamic switch cost: cheap when boundary_head predicts a boundary, expensive inside steady phones!
    bnd = np.clip(phone_bnd_probs.astype(np.float64), 0.01, 0.99)
    dyn_pen = switch_penalty * (1.0 - 0.80 * bnd)  # [0.23 .. 1.15]

    dp = np.full((T, V), -1e18, dtype=np.float64)
    bp = np.zeros((T, V), dtype=np.int32)
    dp[0] = em[0]

    for t in range(1, T):
        prev = dp[t - 1]
        best_prev_idx = int(np.argmax(prev))
        best_prev_val = prev[best_prev_idx]
        # For every state v: either stay in v, or switch from best_prev_idx with cost dyn_pen[t]
        stay = prev
        sw = best_prev_val - dyn_pen[t]
        use_sw = sw > stay
        dp[t] = np.where(use_sw, sw, stay) + em[t]
        bp[t] = np.where(use_sw, best_prev_idx, np.arange(V, dtype=np.int32))

    path = np.zeros(T, dtype=np.int32)
    path[T - 1] = int(np.argmax(dp[T - 1]))
    for t in range(T - 1, 0, -1):
        path[t - 1] = int(bp[t, path[t]])

    # Only split adjacent identical phones at a true local syllable-boundary peak well inside a long vowel
    raw_segs: List[Tuple[int, int, int]] = []
    cur_p = int(path[0])
    cur_s = 0
    for t in range(1, T):
        p = int(path[t])
        is_syl_peak = (
            t + 2 < T
            and path[t + 1] == p
            and float(syl_bnd_probs[t]) >= 0.72
            and float(syl_bnd_probs[t]) >= float(syl_bnd_probs[t - 1])
            and float(syl_bnd_probs[t]) >= float(syl_bnd_probs[t + 1])
        )
        force_split = (
            p == cur_p
            and p != ALIGN_SIL_ID
            and (t - cur_s) >= 4
            and is_syl_peak
            and float(phone_bnd_probs[t]) >= 0.65
        )
        if p != cur_p or force_split:
            raw_segs.append((cur_s, t, cur_p))
            cur_s = t
            cur_p = p
    raw_segs.append((cur_s, T, cur_p))

    # Absorb 1-frame tiny interior sil flickers into neighbor
    cleaned: List[Tuple[int, int, int]] = []
    for s, e, p in raw_segs:
        if p == ALIGN_SIL_ID and (e - s) < min_sil_frames and cleaned and e < T:
            ps, pe, pp = cleaned[-1]
            cleaned[-1] = (ps, e, pp)
        else:
            if cleaned and cleaned[-1][2] == p and float(syl_bnd_probs[s]) < 0.55:
                ps, pe, pp = cleaned[-1]
                cleaned[-1] = (ps, e, pp)
            else:
                cleaned.append((s, e, p))

    out: List[Dict[str, Any]] = []
    for idx, (s, e, pid) in enumerate(cleaned):
        sym = ALIGN_VOCAB[pid] if 0 <= pid < ALIGN_VOCAB_SIZE else "sil"
        conf = float(np.exp(np.clip(np.mean(frame_log_probs[s:e, pid]), -10.0, 0.0)))
        # Tone & lang majority probabilities on segment
        t_mean = tone_probs[s:e].mean(axis=0)
        l_mean = lang_probs[s:e].mean(axis=0)
        tone_id = int(np.argmax(t_mean[1:])) + 1 if pid != ALIGN_SIL_ID else ATONE_NONE
        lang_id = int(np.argmax(l_mean[1:])) + 1 if pid != ALIGN_SIL_ID else ALANG_SIL
        # Check syllable boundary strength around onset frame s
        w0, w1 = max(0, s - 1), min(T, s + 2)
        syl_onset_p = float(np.max(syl_bnd_probs[w0:w1])) if s > 0 else 1.0
        out.append(
            {
                "ipa": sym,
                "pid": pid,
                "start_s": round(s * hop_sec, 4),
                "end_s": round(e * hop_sec, 4),
                "dur_ms": round((e - s) * hop_sec * 1000.0, 1),
                "conf": round(conf, 3),
                "is_sil": pid == ALIGN_SIL_ID,
                "is_vowel": sym in ALIGN_VOWEL_SET,
                "tone_id": tone_id,
                "lang": "sil" if lang_id == ALANG_SIL else ("zh" if lang_id == ALANG_ZH else "en"),
                "zh_prob": round(float(l_mean[ALANG_ZH]), 3),
                "en_prob": round(float(l_mean[ALANG_EN]), 3),
                "syl_onset_prob": round(syl_onset_p, 3),
            }
        )
    return out


def export_praat_textgrid(
    total_sec: float,
    syllables: Sequence[Dict[str, Any]],
    phones: Sequence[Dict[str, Any]],
    *,
    speech_spans: Optional[Sequence[Tuple[float, float, str]]] = None,
    english_word_spans: Optional[Sequence[Tuple[float, float, str]]] = None,
) -> str:
    """Serialize aligned syllables + internal phones (+ optional speech mask) to standard Praat TextGrid."""
    xmax = max(0.02, float(total_sec))

    def _fill_tier(items: Sequence[Tuple[float, float, str]]) -> List[Tuple[float, float, str]]:
        ivs: List[Tuple[float, float, str]] = []
        cur = 0.0
        for s, e, txt in items:
            s_c = max(cur, min(xmax, float(s)))
            e_c = max(s_c, min(xmax, float(e)))
            if s_c > cur + 1e-4:
                ivs.append((cur, s_c, ""))
            if e_c > s_c + 1e-4:
                ivs.append((s_c, e_c, str(txt)))
                cur = e_c
        if cur < xmax - 1e-4:
            ivs.append((cur, xmax, ""))
        return ivs or [(0.0, xmax, "")]

    syl_ivs = _fill_tier([(x["start_s"], x["end_s"], x.get("label", "")) for x in syllables if not x.get("is_sil")])
    ph_ivs = _fill_tier([(x["start_s"], x["end_s"], "" if x.get("is_sil") else x.get("ipa", "")) for x in phones])
    tiers: List[Tuple[str, List[Tuple[float, float, str]]]] = [
        ("syllables", syl_ivs),
        ("phones", ph_ivs),
    ]
    if speech_spans is not None:
        tiers.append(("speech_mask", _fill_tier(speech_spans)))
    if english_word_spans:
        tiers.append(("english_words", _fill_tier(english_word_spans)))

    lines = [
        'File type = "ooTextFile"',
        'Object class = "TextGrid"',
        "",
        "xmin = 0",
        f"xmax = {xmax:.6f}",
        "tiers? <exists>",
        f"size = {len(tiers)}",
        "item []:",
    ]
    for ti, (tname, ivs) in enumerate(tiers, start=1):
        lines.extend([
            f"    item [{ti}]:",
            '        class = "IntervalTier"',
            f'        name = "{tname}"',
            "        xmin = 0",
            f"        xmax = {xmax:.6f}",
            f"        intervals: size = {len(ivs)}",
        ])
        for ii, (s, e, txt) in enumerate(ivs, start=1):
            esc = txt.replace('"', '""')
            lines.extend([
                f"        intervals [{ii}]:",
                f"            xmin = {s:.6f}",
                f"            xmax = {e:.6f}",
                f'            text = "{esc}"',
            ])
    return "\n".join(lines) + "\n"


__all__ = [
    "ALIGN_BLANK_ID",
    "ALIGN_SIL_ID",
    "ALIGN_VOCAB",
    "ALIGN_VOCAB_SIZE",
    "ALIGN_IPA_TO_ID",
    "ALIGN_VOWEL_SET",
    "ATONE_NONE",
    "ATONE_ZH_1",
    "ATONE_ZH_2",
    "ATONE_ZH_3",
    "ATONE_ZH_4",
    "ATONE_ZH_5",
    "ATONE_EN_0",
    "ATONE_EN_1",
    "ALIGN_NUM_TONES",
    "ALANG_SIL",
    "ALANG_ZH",
    "ALANG_EN",
    "ALIGN_NUM_LANGS",
    "REST_M27_PHYS",
    "Vox2AlignLite",
    "normalize_align_ipa",
    "pack_m27_norm",
    "apply_speech_mask_to_m27",
    "viterbi_hybrid_forced_align",
    "blind_decode_phones",
    "export_praat_textgrid",
]
