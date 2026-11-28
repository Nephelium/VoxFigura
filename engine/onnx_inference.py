"""Zero-PyTorch ONNX Runtime inference engine for all 9 VoxFigura Core local models.

Routes every model invocation through `LOCAL_MODEL_MANAGER` so hot-plug load/unload and external
`.onnx` model mounting take effect immediately across the entire server with zero `import torch`.
"""
from __future__ import annotations

import base64
from collections import defaultdict
import importlib.util
import json
from pathlib import Path
import re
import sys
import threading
import time
import unicodedata
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

from model_registry_runtime import LOCAL_MODEL_MANAGER, ModelUnloadedError, TT3_ROOT
import onnx_frontends as ofr

ENGINE_DIR = Path(__file__).resolve().parent
TT3_SRC = TT3_ROOT / "src"
KF_PKG_ROOT = TT3_ROOT / "packages" / "kf_ipa_synth"
MORPH_PKG_ROOT = TT3_ROOT / "m27_voice_morph" / "src"
PTB_CORE_SRC = TT3_ROOT / "ptb" / "packages" / "phonetic_core" / "src"


def ensure_pure_numpy_imports() -> None:
    """Add pure-NumPy helper packages to `sys.path` without touching any PyTorch modules."""
    sys.dont_write_bytecode = True
    for directory in (KF_PKG_ROOT, MORPH_PKG_ROOT, TT3_SRC):
        s = str(directory)
        if s not in sys.path:
            sys.path.insert(0, s)


# ---------------------------------------------------------------------------
# Pure-NumPy activation & math helpers
# ---------------------------------------------------------------------------

def _sigmoid(x: np.ndarray) -> np.ndarray:
    x64 = np.clip(np.asarray(x, dtype=np.float64), -60.0, 60.0)
    return (1.0 / (1.0 + np.exp(-x64))).astype(np.float32)


def _log_softmax(x: np.ndarray, axis: int = -1) -> np.ndarray:
    arr = np.asarray(x, dtype=np.float64)
    m = np.max(arr, axis=axis, keepdims=True)
    shifted = arr - m
    lse = np.log(np.sum(np.exp(shifted), axis=axis, keepdims=True))
    return (shifted - lse).astype(np.float32)


def _softmax(x: np.ndarray, axis: int = -1) -> np.ndarray:
    arr = np.asarray(x, dtype=np.float64)
    m = np.max(arr, axis=axis, keepdims=True)
    ex = np.exp(arr - m)
    return (ex / np.sum(ex, axis=axis, keepdims=True)).astype(np.float32)


# ---------------------------------------------------------------------------
# Speaker Profile JSON Loader (zero-torch replacement for speaker_store.py)
# ---------------------------------------------------------------------------

def load_speaker_profile_embedding(path: Path) -> np.ndarray:
    """Load a 512-dim L2-normalized speaker embedding from `.spk.json` without importing PyTorch."""
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    if "embedding_fp16_b64" in raw:
        vec = np.frombuffer(base64.b64decode(raw["embedding_fp16_b64"]), dtype=np.float16).astype(np.float32)
    elif "embedding_fp32_b64" in raw:
        vec = np.frombuffer(base64.b64decode(raw["embedding_fp32_b64"]), dtype=np.float32).copy()
    elif "embedding" in raw:
        vec = np.asarray(raw["embedding"], dtype=np.float32).reshape(-1)
    else:
        raise ValueError(f"声纹档案缺少 embedding 字段：{path}")
    norm = float(np.linalg.norm(vec))
    if vec.shape != (512,) or not np.isfinite(vec).all() or norm < 1e-6:
        raise ValueError("默认声纹档案需要有效的 512 维向量")
    return np.ascontiguousarray(vec / norm, dtype=np.float32)


# ---------------------------------------------------------------------------
# Pure-NumPy Release-Mode & Soft-Onset Helpers (mirroring kf_ipa_synth.engine)
# ---------------------------------------------------------------------------

def apply_soft_onset_200hz(m27_200: np.ndarray, leading_sil_sec: float) -> np.ndarray:
    arr = np.asarray(m27_200, dtype=np.float64).copy()
    n200 = arr.shape[0]
    if n200 < 2:
        return arr
    if leading_sil_sec >= 0.02:
        ramp_sec = min(0.045, max(0.020, leading_sil_sec * 0.70))
        n_ramp = min(n200, max(4, int(round(ramp_sec / 0.005))))
        u = np.linspace(0.0, 1.0, n_ramp, dtype=np.float64)
        arr[:n_ramp, 18] *= 0.5 * (1.0 - np.cos(np.pi * u))
        half_r = max(2, n_ramp // 2)
        arr[:half_r, 23] = np.minimum(arr[:half_r, 23], 0.0)
    else:
        n_ramp = min(n200, 4)
        u = np.linspace(0.0, 1.0, n_ramp, dtype=np.float64)
        arr[:n_ramp, 18] *= 0.5 * (1.0 - np.cos(np.pi * u))
    return arr


def enforce_release_modes_50hz(
    m27_50: np.ndarray,
    segments: Sequence[Any],
    role_by_idx: Sequence[str],
    frame_t: np.ndarray,
) -> np.ndarray:
    arr = np.asarray(m27_50, dtype=np.float32).copy()
    for idx_s, seg in enumerate(segments):
        role = role_by_idx[idx_s] if idx_s < len(role_by_idx) else "normal"
        if role not in ("nasal_release", "lateral_release"):
            continue
        idxs = np.flatnonzero((frame_t >= seg.start_sec) & (frame_t < seg.end_sec))
        if idxs.size == 0:
            nearest = int(np.clip(np.floor(0.5 * (seg.start_sec + seg.end_sec) / 0.02), 0, arr.shape[0] - 1))
            idxs = np.array([nearest], dtype=np.int64)
        if role == "nasal_release":
            arr[idxs, 7] = np.maximum(arr[idxs, 7], 0.70)
            arr[idxs, 6] = np.minimum(arr[idxs, 6], 0.75)
            if idx_s > 0 and role_by_idx[idx_s - 1] == "closure":
                p_seg = segments[idx_s - 1]
                p_idx = np.flatnonzero((frame_t >= p_seg.start_sec) & (frame_t < p_seg.end_sec))
                if p_idx.size:
                    arr[p_idx, 7] = np.minimum(arr[p_idx, 7], -0.05)
        elif role == "lateral_release":
            arr[idxs, 16] = np.minimum(arr[idxs, 16], -0.90)
            arr[idxs, 15] = np.minimum(arr[idxs, 15], -0.18)
            if idx_s > 0 and role_by_idx[idx_s - 1] == "closure":
                p_seg = segments[idx_s - 1]
                p_idx = np.flatnonzero((frame_t >= p_seg.start_sec) & (frame_t < p_seg.end_sec))
                if p_idx.size:
                    arr[p_idx, 16] = np.maximum(arr[p_idx, 16], 0.0)
    return arr


def apply_unreleased_zero_pressure_200hz(
    m27_200: np.ndarray,
    segments: Sequence[Any],
    role_by_idx: Sequence[str],
) -> np.ndarray:
    ensure_pure_numpy_imports()
    from kf_ipa_synth.phonetics import validate_ipa_diacritics

    arr = np.asarray(m27_200, dtype=np.float64).copy()
    n200 = arr.shape[0]
    if n200 < 2:
        return arr
    for idx_s, seg in enumerate(segments):
        role = role_by_idx[idx_s] if idx_s < len(role_by_idx) else "normal"
        if role not in ("closure", "hold", "normal") or ("\u031a" not in seg.ipa):
            continue
        val_d = validate_ipa_diacritics(seg.ipa)
        if "\u031a" in val_d["ignored_diacritics"]:  # type: ignore[operator]
            continue
        i0 = max(0, min(n200, int(round(seg.start_sec / 0.005))))
        i1 = max(i0 + 1, min(n200, int(round(seg.end_sec / 0.005))))
        seg_len = i1 - i0
        n_decay = max(4, int(round(seg_len * 0.55)))
        d0 = max(i0, i1 - n_decay)
        u = np.linspace(0.0, 1.0, i1 - d0, dtype=np.float64)
        arr[d0:i1, 18] *= 0.5 * (1.0 + np.cos(np.pi * u))
        ra0 = max(i0, i1 - max(3, int(round(seg_len * 0.40))))
        u_ra = np.linspace(0.0, 1.0, i1 - ra0, dtype=np.float64)
        arr[ra0:i1, 23] *= 0.5 * (1.0 + np.cos(np.pi * u_ra))
        nxt_is_sil = (idx_s + 1 >= len(segments)) or segments[idx_s + 1].is_sil
        if nxt_is_sil and i1 < n200:
            if idx_s + 1 < len(segments):
                sil_end = min(n200, int(round(segments[idx_s + 1].end_sec / 0.005)))
                has_more_speech = any(not s.is_sil for s in segments[idx_s + 2 :])
                if has_more_speech and (sil_end - i1) > 6:
                    ramp_k = min(5, (sil_end - i1) // 2)
                    arr[i1 : sil_end - ramp_k, 18] = 0.0
                    arr[i1 : sil_end - ramp_k, 23] = 0.0
                    u_up = np.linspace(0.0, 1.0, ramp_k, dtype=np.float64)
                    arr[sil_end - ramp_k : sil_end, 18] *= 0.5 * (1.0 - np.cos(np.pi * u_up))
                else:
                    arr[i1:sil_end, 18] = 0.0
                    arr[i1:sil_end, 23] = 0.0
            else:
                arr[i1:n200, 18] = 0.0
                arr[i1:n200, 23] = 0.0
    return arr


# ---------------------------------------------------------------------------
# 1. Tract2Area-Proxy (ONNX)
# ---------------------------------------------------------------------------

def predict_tract_area_cm2(tract17_norm: np.ndarray) -> np.ndarray:
    """Predict 6-zone vocal tract cross-sectional areas (cm²) from normalized tract17."""
    arr = np.asarray(tract17_norm, dtype=np.float32)
    orig_ndim = arr.ndim
    if orig_ndim == 1:
        inp = arr[None, None, :]
    elif orig_ndim == 2:
        inp = arr[None, :, :]
    else:
        inp = arr
    sess, _ = LOCAL_MODEL_MANAGER.require_session("Tract2Area-Proxy", device="cpu")
    out = sess.run(["area_cm2"], {"tract17_norm": np.ascontiguousarray(inp, dtype=np.float32)})[0]
    if orig_ndim == 1:
        return out[0, 0]
    if orig_ndim == 2:
        return out[0]
    return out


# ---------------------------------------------------------------------------
# 2. IPA2Tract-Lite (ONNX)
# ---------------------------------------------------------------------------

def active_ipa2tract_cond_dim() -> int:
    """Return the active `IPA2Tract-Lite` ONNX `cond` channel width (111 for legacy 22d, 121 for v4 32d)."""
    sess, _ = LOCAL_MODEL_MANAGER.require_session("IPA2Tract-Lite", device="cpu")
    shape = sess.get_inputs()[0].shape
    if len(shape) >= 3 and isinstance(shape[2], int) and shape[2] in (111, 121):
        return int(shape[2])
    return 111


def predict_ipa2tract(
    cond_111: np.ndarray,
    x_base_26: np.ndarray,
    alpha: float = 1.0,
    *,
    articulation_spans: Optional[Sequence[Dict[str, Any]]] = None,
    step_hz: int = 200,
) -> np.ndarray:
    """Predict 50 Hz coarticulated 26-dim trajectory via `IPA2Tract-Lite` ONNX (<=10s chunked + cached)."""
    from chunked_synthesis import predict_ipa2tract_chunked

    return predict_ipa2tract_chunked(
        cond_111,
        x_base_26,
        alpha=alpha,
        articulation_spans=articulation_spans,
        step_hz=step_hz,
    )


# ---------------------------------------------------------------------------
# 3. Vox2Spk-Lite (ONNX)
# ---------------------------------------------------------------------------

def extract_speaker_embedding(
    wav_16k: np.ndarray,
    *,
    device: str = "cpu",
    power: Optional[np.ndarray] = None,
) -> Tuple[np.ndarray, str]:
    """Extract L2-normalized `(512,)` speaker embedding via `Vox2Spk-Lite` ONNX."""
    log_mel = ofr.extract_cmn_logmel_spk(wav_16k, power=power)
    sess, actual = LOCAL_MODEL_MANAGER.require_session("Vox2Spk-Lite", device=device)
    emb = sess.run(["spk_emb"], {"log_mel": log_mel})[0][0]
    norm = float(np.linalg.norm(emb))
    if norm > 1e-6:
        emb = emb / norm
    return np.ascontiguousarray(emb, dtype=np.float32), actual


# ---------------------------------------------------------------------------
# 4. Tract2Vox-Lite (ONNX)
# ---------------------------------------------------------------------------

def synthesize_tract2vox(
    m27_norm: np.ndarray,
    spk_emb_or_seq: np.ndarray,
    *,
    m27_phys_dpa: Optional[np.ndarray] = None,
    articulation_spans: Optional[Sequence[Dict[str, Any]]] = None,
    step_hz: int = 200,
    device: str = "cpu",
    seed: int = 20261122,
    allow_parallel: bool = True,
) -> Tuple[np.ndarray, str]:
    """Synthesize 16 kHz mono float32 waveform `(T * 320,)` via `Tract2Vox-Lite` ONNX.

    Automatically applies <=10s smart chunking, per-chunk content-hash caching, and multi-core parallelism.
    Accepts either a static `(512,)` / `(1, 512)` speaker vector OR time-varying `(T, 512)` / `(1, T, 512)` sequence.
    """
    from chunked_synthesis import synthesize_tract2vox_chunked

    wav, actual, _ = synthesize_tract2vox_chunked(
        m27_norm,
        spk_emb_or_seq,
        m27_phys_dpa=m27_phys_dpa,
        articulation_spans=articulation_spans,
        step_hz=step_hz,
        device=device,
        seed=seed,
        allow_parallel=allow_parallel,
    )
    return wav, actual


# ---------------------------------------------------------------------------
# 5. SwiftF0 & DPDFNet (existing ONNX routed through hot-plug manager)
# ---------------------------------------------------------------------------

_PTB_NEURAL_LOCK = threading.Lock()
_PTB_NEURAL_MODULE = None


def _get_ptb_neural_module():
    global _PTB_NEURAL_MODULE
    if _PTB_NEURAL_MODULE is not None:
        return _PTB_NEURAL_MODULE
    with _PTB_NEURAL_LOCK:
        if _PTB_NEURAL_MODULE is not None:
            return _PTB_NEURAL_MODULE
        src = PTB_CORE_SRC / "phonetic_core" / "acoustic" / "neural.py"
        if not src.is_file():
            raise FileNotFoundError(f"缺少 PhoneticToolbox 声学神经模块：{src}")
        mod_name = "_vocalcut_ptb_acoustic_onnx"
        spec = importlib.util.spec_from_file_location(mod_name, str(src))
        if spec is None:
            raise ImportError(f"无法加载 {src}")
        module = importlib.util.module_from_spec(spec)
        sys.modules[mod_name] = module
        exec(compile(src.read_bytes(), str(src), "exec"), module.__dict__)
        _PTB_NEURAL_MODULE = module
        return module


def extract_swift_f0_50hz(
    wav_16k: np.ndarray,
    *,
    fmin: float = 46.875,
    fmax: float = 2093.75,
    num_frames: Optional[int] = None,
) -> Tuple[np.ndarray, np.ndarray]:
    """Extract 50 Hz aligned F0 (Hz) and voiced mask using hot-pluggable `SwiftF0` ONNX."""
    x = np.asarray(wav_16k, dtype=np.float32).reshape(-1)
    if num_frames is None:
        num_frames = max(1, len(x) // ofr.HOP_SAMPLES_16K)
    sess, _ = LOCAL_MODEL_MANAGER.require_session("SwiftF0", device="cpu")
    neural_mod = _get_ptb_neural_module()
    target_times = (np.arange(num_frames, dtype=np.float64) + 0.5) * 0.020
    pitch = neural_mod.swift_pitch(x, ofr.SAMPLE_RATE_16K, sess, low=float(fmin), high=float(fmax))

    if len(pitch.times) == 0:
        return np.full(num_frames, 120.0, dtype=np.float32), np.zeros(num_frames, dtype=bool)
    raw_valid = np.isfinite(pitch.values)
    if not raw_valid.any():
        return np.full(num_frames, 120.0, dtype=np.float32), np.zeros(num_frames, dtype=bool)

    # Filter out isolated ultra-low-energy silence/noise false pitch detections
    # (e.g. faint -38 dB leading room tone triggering a 1500 Hz harmonic spike under wide fmax).
    valid = raw_valid.copy()
    if len(x) >= 160:
        half_win = 160  # ±10 ms @ 16 kHz
        frame_rms = np.empty(len(pitch.times), dtype=np.float64)
        for i, t_sec in enumerate(pitch.times):
            c = int(round(float(t_sec) * ofr.SAMPLE_RATE_16K))
            lo = max(0, c - half_win)
            hi = min(len(x), c + half_win)
            seg = x[lo:hi]
            frame_rms[i] = float(np.sqrt(np.mean(seg * seg))) if len(seg) else 0.0
        peak_rms = float(np.max(frame_rms)) if len(frame_rms) else 0.0
        if peak_rms > 1e-4:
            rms_floor = max(0.004, peak_rms * 0.035)
            gated = valid & (frame_rms >= rms_floor)
            if gated.any():
                valid = gated

    # Also drop tiny 1–2 frame isolated extreme octave-jump glitches surrounded by unvoiced gaps
    if int(np.sum(valid)) >= 4:
        med_f0 = float(np.median(pitch.values[valid]))
        idx = 0
        n_pts = len(valid)
        cleaned = valid.copy()
        while idx < n_pts:
            if not valid[idx]:
                idx += 1
                continue
            end = idx
            while end < n_pts and valid[end]:
                end += 1
            if end - idx <= 2:
                seg_vals = pitch.values[idx:end]
                if np.all((seg_vals > med_f0 * 2.4) | (seg_vals < med_f0 / 2.4)):
                    cleaned[idx:end] = False
            idx = end
        if cleaned.any():
            valid = cleaned

    f0_interp = np.interp(target_times, pitch.times[valid], pitch.values[valid])
    f0_interp = np.clip(f0_interp, float(fmin), float(fmax)).astype(np.float32)
    voiced_prob = np.interp(target_times, pitch.times, valid.astype(np.float64))
    return f0_interp, (voiced_prob >= 0.5)


def denoise_channel_dpdfnet(channel: np.ndarray, rate: int) -> np.ndarray:
    """Denoise one audio channel via hot-pluggable `DPDFNet` ONNX."""
    sess, _ = LOCAL_MODEL_MANAGER.require_session("DPDFNet", device="cpu")
    neural_mod = _get_ptb_neural_module()
    return neural_mod.dpdfnet(channel, rate, sess)


# ---------------------------------------------------------------------------
# 6. Vox2Tract-Lite & Vox2Align-Lite v2 (ONNX + Shared STFT + Viterbi)
# ---------------------------------------------------------------------------

V2_BLANK_ID = 0
V2_SIL_ID = 1
ALANG_SIL = 0
ALANG_ZH = 1
ALANG_EN = 2
ATONE_EN_1 = 7

ALIGN_VOCAB_V2: Tuple[str, ...] = (
    "<blank>", "sil",
    "p", "pʰ", "b", "t", "tʰ", "d", "k", "kʰ", "ɡ",
    "f", "v", "θ", "ð", "s", "z", "ʂ", "ɻ", "ʃ", "ʒ", "ɕ", "x", "h",
    "ts", "tsʰ", "tʂ", "tʂʰ", "tʃ", "dʒ", "tɕ", "tɕʰ",
    "m", "n", "ŋ", "l", "ɹ", "j", "w", "ɥ",
    "a", "ɑ", "æ", "ʌ", "ɛ", "ɤ", "ə", "ɚ", "ɝ",
    "i", "ɪ", "o", "ɔ", "u", "ʊ", "y", "ɹ̩", "ɻ̍", "ʋ̩",
    "aɪ", "aʊ", "ɑʊ", "eɪ", "oʊ", "ɔɪ",
)
ALIGN_V2_IPA_TO_ID: Dict[str, int] = {sym: idx for idx, sym in enumerate(ALIGN_VOCAB_V2)}
ALIGN_V2_VOWEL_SET = frozenset({
    "a", "ɑ", "æ", "ʌ", "ɛ", "ɤ", "ə", "ɚ", "ɝ",
    "i", "ɪ", "o", "ɔ", "u", "ʊ", "y", "ɹ̩", "ɻ̍", "ʋ̩",
    "aɪ", "aʊ", "ɑʊ", "eɪ", "oʊ", "ɔɪ",
})
_EN_NORM_V2 = {
    "g": "ɡ", "r": "ɹ", "ɜ": "ɝ", "ɚ": "ɝ", "ɨ": "ɪ", "ʉ": "u", "ɦ": "h",
    "ɾ": "t", "ʔ": "t", "ɾ̃": "n", "ə̥": "ə", "e": "eɪ", "o": "oʊ", "ɒ": "ɔ", "a": "ɑ",
    "l̩": "l", "m̩": "m", "n̩": "n", "ŋ̩": "ŋ",
}
_TONE_STR_TO_NUM = {"55": 1, "35": 2, "214": 3, "21": 3, "51": 4, "0": 5, "1": 1, "2": 2, "3": 3, "4": 4, "5": 5}
_EN_ONSETS = frozenset(
    "bl bɹ bj dɹ dw fl fɹ fj ɡl ɡɹ ɡj kl kɹ kw kj mj nj pl pɹ pj sk sl sm sn sp st sw tɹ tw tj θɹ ʃɹ skl skɹ skw spl spɹ stɹ".split()
)
# Calibrated JD2 schwa [ə] resting vocal-tract posture (from factory/JD2/ipa.json `@jd2:ə`) + silent glottis
REST_M27_PHYS = np.array(
    [
        0.2826, -4.875404, -0.0711, -4.032121, 0.204001, 0.229023, 0.5615, -0.1,
        0.076805, -2.158131, 4.170966, -0.291514, 2.079013, -0.776175, 0.1763, 0.1265, 0.0314,
        130.0, 0.0, 0.0, 0.0, 0.12, 0.0, 0.0, 0.0, 0.0, 0.0,
    ],
    dtype=np.float32,
)
_EN_LEXICON_CACHE: Optional[Dict[Tuple[str, ...], str]] = None


def _normalize_en_ipa_v2(ipa: str) -> str:
    s = (ipa or "").strip().replace("͡", "").replace("͜", "").replace("ʰ", "").replace("ː", "")
    if not s or s in ("sil", "sp", "pau", "h#", "epi", "<AP>", "<SP>", "AP", "SP"):
        return "sil"
    s = _EN_NORM_V2.get(s, s)
    if s in ALIGN_V2_IPA_TO_ID:
        return s
    s2 = _EN_NORM_V2.get(s.replace("̩", ""), s.replace("̩", ""))
    return s2 if s2 in ALIGN_V2_IPA_TO_ID else "sil"


def _get_en_lexicon() -> Dict[Tuple[str, ...], str]:
    """Load BSD-2-Clause CMUdict word pronunciations mapped to US English IPA sequences."""
    global _EN_LEXICON_CACHE
    if _EN_LEXICON_CACHE is not None:
        return _EN_LEXICON_CACHE
    ensure_pure_numpy_imports()
    from tt3.mandarin_unt_ipa import arpabet_to_en_ipa_and_stress

    tbl: Dict[Tuple[str, ...], str] = {}
    cand = ENGINE_DIR.parent / "public" / "vocal-tract" / "assets" / "cmudict.dict"
    if cand.is_file():
        for ln in cand.read_text(encoding="utf-8", errors="replace").splitlines():
            fields = ln.partition("#")[0].split()
            if len(fields) < 2 or fields[0].startswith(";"):
                continue
            w = re.sub(r"\([0-9]+\)$", "", fields[0].lower())
            if not re.match(r"^[a-z][a-z'\-]*$", w):
                continue
            seq: List[str] = []
            for tok in fields[1:]:
                ipa, _ = arpabet_to_en_ipa_and_stress(tok)
                if ipa != "sil":
                    seq.append(ipa)
            if seq and tuple(seq) not in tbl:
                tbl[tuple(seq)] = w
    _EN_LEXICON_CACHE = tbl
    return tbl


def apply_speech_mask_to_m27(
    m27_phys: np.ndarray,
    speech_prob: np.ndarray,
    *,
    threshold: float = 0.42,
    ramp_frames: int = 2,
) -> Tuple[np.ndarray, np.ndarray]:
    arr = np.asarray(m27_phys, dtype=np.float32).copy()
    p = np.asarray(speech_prob, dtype=np.float32).reshape(-1)
    t_len = min(arr.shape[0], p.shape[0])
    if t_len == 0:
        return arr, p
    soft = np.clip((p[:t_len] - 0.22) / max(0.05, float(threshold) - 0.14), 0.0, 1.0).astype(np.float32)
    if ramp_frames > 0 and t_len > 2:
        k = int(ramp_frames)
        win = np.hanning(2 * k + 3)[1:-1].astype(np.float32)
        win /= np.maximum(win.sum(), 1e-6)
        gate = np.convolve(np.pad(soft, (k, k), mode="edge"), win, mode="valid")
        gate = np.where(p[:t_len] < 0.15, gate * 0.25, gate)
        gate = np.clip(gate, 0.0, 1.0).astype(np.float32)
    else:
        gate = soft
    g_col = gate[:, None]
    arr[:t_len, :17] = g_col * arr[:t_len, :17] + (1.0 - g_col) * REST_M27_PHYS[None, :17]
    arr[:t_len, 18:] = g_col * arr[:t_len, 18:] + (1.0 - g_col) * REST_M27_PHYS[None, 18:]
    return arr, gate


def _quiet_pause_speech_mask(wav_16k: np.ndarray) -> np.ndarray:
    """Find sustained low-energy pauses at 50 Hz when phone alignment is disabled."""
    frames = wav_16k.reshape(-1, ofr.HOP_SAMPLES_16K)
    rms = np.sqrt(np.mean(frames * frames, axis=1))
    quiet = rms <= max(1e-5, min(10 ** (-50 / 20), float(rms.max()) * 0.02))
    edges = np.flatnonzero(np.diff(np.r_[False, quiet, False]))
    speech = np.ones(len(frames), dtype=np.float32)
    for start, end in edges.reshape(-1, 2):
        # Require longer gaps inside speech so ordinary stop closures retain their gestures.
        min_frames = 3 if start == 0 or end == len(frames) else 6
        if end - start >= min_frames:
            speech[start:end] = 0
    return speech


def _export_praat_textgrid(
    total_sec: float,
    syllables: Sequence[Dict[str, Any]],
    phones: Sequence[Dict[str, Any]],
    *,
    speech_spans: Optional[Sequence[Tuple[float, float, str]]] = None,
    english_word_spans: Optional[Sequence[Tuple[float, float, str]]] = None,
) -> str:
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

    tiers: List[Tuple[str, List[Tuple[float, float, str]]]] = [
        ("syllables", _fill_tier([(x["start_s"], x["end_s"], x.get("label", "")) for x in syllables if not x.get("is_sil")])),
        ("phones", _fill_tier([(x["start_s"], x["end_s"], "" if x.get("is_sil") else x.get("ipa", "")) for x in phones])),
    ]
    if speech_spans is not None:
        tiers.append(("speech_mask", _fill_tier(speech_spans)))
    if english_word_spans:
        tiers.append(("english_words", _fill_tier(english_word_spans)))

    lines = [
        'File type = "ooTextFile"', 'Object class = "TextGrid"', "",
        "xmin = 0", f"xmax = {xmax:.6f}", "tiers? <exists>", f"size = {len(tiers)}", "item []:",
    ]
    for ti, (tname, ivs) in enumerate(tiers, start=1):
        lines.extend([
            f"    item [{ti}]:", '        class = "IntervalTier"', f'        name = "{tname}"',
            "        xmin = 0", f"        xmax = {xmax:.6f}", f"        intervals: size = {len(ivs)}",
        ])
        for ii, (s, e, txt) in enumerate(ivs, start=1):
            esc = txt.replace('"', '""')
            lines.extend([
                f"        intervals [{ii}]:", f"            xmin = {s:.6f}",
                f"            xmax = {e:.6f}", f'            text = "{esc}"',
            ])
    return "\n".join(lines) + "\n"


def _viterbi_guided_align_v2(
    frame_log_probs: np.ndarray,
    ctc_log_probs: np.ndarray,
    phone_bnd_probs: np.ndarray,
    speech_probs: np.ndarray,
    target_phone_ids: Sequence[int],
    *,
    optional_sil_after: Optional[Sequence[bool]] = None,
    hop_sec: float = 0.02,
) -> Tuple[List[Tuple[float, float, int, float]], float]:
    t_len, _ = frame_log_probs.shape
    n_ph = len(target_phone_ids)
    if n_ph == 0 or t_len == 0:
        return [], -99.0

    em = 0.72 * frame_log_probs.astype(np.float64) + 0.28 * ctc_log_probs.astype(np.float64)
    sp = np.clip(speech_probs.astype(np.float64), 1e-4, 1.0 - 1e-4)
    em[:, V2_SIL_ID] += 1.05 * np.log(1.0 - sp)
    em[:, 2:] += 0.65 * np.log(sp)[:, None]

    b_log = np.log(np.clip(phone_bnd_probs.astype(np.float64), 1e-4, 1.0))
    nb_log = np.log(np.clip(1.0 - phone_bnd_probs.astype(np.float64), 1e-4, 1.0))

    states_pid: List[int] = [V2_SIL_ID]
    states_phone_idx: List[int] = [-1]
    for idx, pid in enumerate(target_phone_ids):
        states_pid.append(int(pid))
        states_phone_idx.append(idx)
        allow_sil = (idx == n_ph - 1) or (
            optional_sil_after is not None and idx < len(optional_sil_after) and optional_sil_after[idx]
        )
        if allow_sil:
            states_pid.append(V2_SIL_ID)
            states_phone_idx.append(-1)

    s_len = len(states_pid)
    st_pid = np.asarray(states_pid, dtype=np.int32)
    is_sil_state = np.asarray([p_idx < 0 for p_idx in states_phone_idx], dtype=bool)
    can_skip = np.zeros(s_len, dtype=bool)
    for s in range(2, s_len):
        if is_sil_state[s - 1] and not is_sil_state[s]:
            can_skip[s] = True
    sil_pen = np.zeros(s_len, dtype=np.float64)
    for s in range(1, s_len - 1):
        if is_sil_state[s]:
            sil_pen[s] = -0.10

    neg_inf = -1e18
    dp = np.full((t_len, s_len), neg_inf, dtype=np.float64)
    bp = np.zeros((t_len, s_len), dtype=np.int32)
    dp[0, 0] = em[0, V2_SIL_ID]
    if s_len > 1:
        dp[0, 1] = em[0, st_pid[1]]

    s_idx = np.arange(s_len, dtype=np.int32)
    w_bnd = 0.30
    for t in range(1, t_len):
        prev = dp[t - 1]
        stay = prev + w_bnd * nb_log[t]
        step1 = np.full(s_len, neg_inf, dtype=np.float64)
        step1[1:] = prev[:-1] + w_bnd * b_log[t]
        step2 = np.full(s_len, neg_inf, dtype=np.float64)
        if s_len > 2:
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

    end_cands = [s_len - 1]
    if s_len >= 2 and is_sil_state[s_len - 1]:
        end_cands.append(s_len - 2)
    cur = max(end_cands, key=lambda c: dp[t_len - 1, c])
    total_score = float(dp[t_len - 1, cur])

    path = np.zeros(t_len, dtype=np.int32)
    path[t_len - 1] = cur
    for t in range(t_len - 1, 0, -1):
        cur = int(bp[t, cur])
        path[t - 1] = cur

    spans_by_idx: Dict[int, List[int]] = {}
    for t in range(t_len):
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
            s_sec, e_sec = t0 * hop_sec, t1 * hop_sec
            last_end = e_sec
            out_spans.append((s_sec, e_sec, int(pid), sc))
        else:
            s_sec = last_end
            e_sec = min(t_len * hop_sec, last_end + hop_sec)
            last_end = e_sec
            out_spans.append((s_sec, e_sec, int(pid), -5.0))
    return out_spans, total_score / float(max(1, t_len))


def _validate_guided_text(text: str) -> Optional[Dict[str, str]]:
    if not text:
        return {"code": "text_required", "hint": "请提供与录音一致的普通话或英语原文"}
    if len(text) > 4000:
        return {"code": "text_too_long", "hint": "单次对齐最多输入 4000 个字符，请分段处理"}
    spoken = re.sub(r"(?<=[A-Za-z])[1-5](?!\w)", "", text)
    if any(ch.isdecimal() for ch in spoken):
        return {"code": "unsupported_text", "hint": "请把数字按录音中的实际读法写成汉字或英语单词"}
    if not re.search(r"[A-Za-z\u4e00-\u9fff]", spoken) or any(
        not (ch.isspace() or unicodedata.category(ch).startswith("P") or re.fullmatch(r"[A-Za-z\u4e00-\u9fff]", ch))
        for ch in spoken
    ):
        return {"code": "unsupported_text", "hint": "此模型支持普通话与英语原文，请检查输入文字"}
    return None


def _split_aligned_english_word(phones: List[Dict[str, Any]]) -> List[List[Dict[str, Any]]]:
    nuclei = [i for i, phone in enumerate(phones) if phone["is_vowel"]]
    starts = [0]
    for previous, current in zip(nuclei, nuclei[1:]):
        onset = current
        if current > previous + 1 and phones[current - 1]["ipa"] != "ŋ":
            onset -= 1
            while onset > previous + 1 and "".join(p["ipa"] for p in phones[onset - 1 : current]) in _EN_ONSETS:
                onset -= 1
        starts.append(onset)
    return [phones[start:end] for start, end in zip(starts, starts[1:] + [len(phones)])]


def _text_to_v2_target_hierarchy(text: str, lang: str = "auto") -> Tuple[List[Dict[str, Any]], List[int], List[bool]]:
    ensure_pure_numpy_imports()
    from kf_ipa_synth.text2ipa import convert_text_to_timeline
    from tt3.mandarin_unt_ipa import add_pinyin_tone_mark, normalize_mandarin_pinyin, pinyin_to_unt_phones

    tl = convert_text_to_timeline(text, lang=lang, base_f0=165.0, tone_sandhi=True)
    kfs = tl.get("keyframes", [])
    syl_by_id = {str(s["id"]): s for s in tl.get("syllables", [])}

    syl_groups: List[Dict[str, Any]] = []
    cur_sid: Optional[str] = None
    cur_ipas: List[str] = []
    cur_meta: Dict[str, Any] = {}

    def _flush() -> None:
        if not cur_ipas and not cur_meta:
            return
        s_lang = str(cur_meta.get("lang", lang)).lower()
        lg = "zh" if s_lang.startswith("zh") else ("en" if s_lang.startswith("en") else "auto")
        txt_lbl = str(cur_meta.get("text", "")).strip()
        py_raw = str(cur_meta.get("pinyin", "")).strip()
        if not py_raw and lg == "zh":
            cands = cur_meta.get("candidates") or []
            ac = int(cur_meta.get("active_candidate", 0) or 0)
            if cands and 0 <= ac < len(cands):
                lbl_c = str(cands[ac].get("label", "")).strip()
                if lbl_c:
                    py_raw = lbl_c.split()[0]
        t_str = str(cur_meta.get("tone", ""))
        norm_ipas: List[str] = []
        pids: List[int] = []
        py_display = ""
        if lg == "zh" and py_raw:
            base_py, parsed_t = normalize_mandarin_pinyin(py_raw)
            t_num = _TONE_STR_TO_NUM.get(t_str, parsed_t)
            unt_phs = pinyin_to_unt_phones(base_py, tone=t_num, char=txt_lbl[:1])
            py_display = add_pinyin_tone_mark(base_py, t_num)
            for p in unt_phs:
                pid = ALIGN_V2_IPA_TO_ID.get(p, V2_SIL_ID)
                if pid > V2_SIL_ID:
                    pids.append(pid)
                    norm_ipas.append(p)
        else:
            for p in cur_ipas:
                np_ipa = _normalize_en_ipa_v2(p)
                pid = ALIGN_V2_IPA_TO_ID.get(np_ipa, V2_SIL_ID)
                if pid > V2_SIL_ID:
                    pids.append(pid)
                    norm_ipas.append(np_ipa)
        if pids:
            syl_groups.append({
                "text": txt_lbl or "".join(norm_ipas),
                "pinyin": py_display, "lang": lg, "tone": t_str, "pids": pids, "ipas": norm_ipas,
            })

    for kf in kfs:
        ipa = str(kf.get("ipa", ""))
        role = str(kf.get("role", "normal"))
        if ipa in ("sil", "") or role in ("silence", "closure"):
            continue
        sid = str(kf.get("syl_id", ""))
        if sid != cur_sid:
            _flush()
            cur_sid = sid
            cur_ipas = []
            cur_meta = syl_by_id.get(sid, {})
        cur_ipas.append(ipa)
    _flush()

    flat_pids: List[int] = []
    opt_sil_after: List[bool] = []
    for sg in syl_groups:
        for idx_p, pid in enumerate(sg["pids"]):
            flat_pids.append(pid)
            opt_sil_after.append(idx_p == len(sg["pids"]) - 1)
    return syl_groups, flat_pids, opt_sil_after


def _blind_decode_en_island(
    frame_lp: np.ndarray,
    bnd_p: np.ndarray,
    sp_p: np.ndarray,
    tone_p: np.ndarray,
    t_offset: int,
    hop_sec: float = 0.02,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    t_len, v_len = frame_lp.shape
    em = frame_lp.astype(np.float64).copy()
    em[:, V2_BLANK_ID] = -1e9
    sp = np.clip(sp_p.astype(np.float64), 1e-4, 1.0 - 1e-4)
    em[:, V2_SIL_ID] += 0.65 * np.log(1.0 - sp)
    em[:, 2:] += 0.35 * np.log(sp)[:, None]
    bnd = np.clip(bnd_p[:, 0].astype(np.float64), 0.01, 0.99)
    dyn_pen = 1.10 * (1.0 - 0.80 * bnd)
    dp = np.full((t_len, v_len), -1e18, dtype=np.float64)
    bp = np.zeros((t_len, v_len), dtype=np.int32)
    dp[0] = em[0]
    for t in range(1, t_len):
        prev = dp[t - 1]
        best_i = int(np.argmax(prev))
        sw = prev[best_i] - dyn_pen[t]
        use_sw = sw > prev
        dp[t] = np.where(use_sw, sw, prev) + em[t]
        bp[t] = np.where(use_sw, best_i, np.arange(v_len, dtype=np.int32))
    path = np.zeros(t_len, dtype=np.int32)
    path[t_len - 1] = int(np.argmax(dp[t_len - 1]))
    for t in range(t_len - 1, 0, -1):
        path[t - 1] = int(bp[t, path[t]])

    segs: List[Tuple[int, int, int]] = []
    cur_p, cur_s = int(path[0]), 0
    for t in range(1, t_len):
        if int(path[t]) != cur_p:
            segs.append((cur_s, t, cur_p))
            cur_s, cur_p = t, int(path[t])
    segs.append((cur_s, t_len, cur_p))

    phones: List[Dict[str, Any]] = []
    for s, e, pid in segs:
        if pid <= V2_SIL_ID:
            continue
        sym = ALIGN_VOCAB_V2[pid]
        conf = float(np.exp(np.clip(np.mean(frame_lp[s:e, pid]), -10.0, 0.0)))
        w0, w1 = max(0, s - 1), min(t_len, s + 2)
        syl_p = float(np.max(bnd_p[w0:w1, 1])) if s > 0 else 1.0
        t_m = tone_p[s:e].mean(axis=0)
        tid = int(np.argmax(t_m[6:])) + 6
        phones.append({
            "ipa": sym, "pid": pid,
            "start_s": round((t_offset + s) * hop_sec, 4),
            "end_s": round((t_offset + e) * hop_sec, 4),
            "dur_ms": round((e - s) * hop_sec * 1000.0, 1),
            "conf": round(conf, 3), "is_sil": False,
            "is_vowel": sym in ALIGN_V2_VOWEL_SET,
            "lang": "en", "tone_id": tid, "syl_onset_prob": syl_p,
        })
    if not phones:
        return [], []
    groups: List[List[Dict[str, Any]]] = [[phones[0]]]
    for ph in phones[1:]:
        if any(x["is_vowel"] for x in groups[-1]) and ph["syl_onset_prob"] >= 0.45:
            groups.append([ph])
        else:
            groups[-1].append(ph)
    merged: List[List[Dict[str, Any]]] = []
    for g in groups:
        if not any(x["is_vowel"] for x in g) and merged:
            merged[-1].extend(g)
        else:
            merged.append(g)
    lex = _get_en_lexicon()
    syllables: List[Dict[str, Any]] = []
    for grp in merged:
        seq = tuple(x["ipa"] for x in grp)
        matched_w = lex.get(seq)
        stressed = any(x["tone_id"] == ATONE_EN_1 for x in grp if x["is_vowel"])
        ipa_str = ("ˈ" if stressed else "") + "/" + "".join(seq) + "/"
        lbl = f"{matched_w} ({ipa_str})" if matched_w else ipa_str
        syllables.append({
            "label": lbl, "sub_label": matched_w or "", "lang": "en",
            "start_s": grp[0]["start_s"], "end_s": grp[-1]["end_s"],
            "dur_ms": round((grp[-1]["end_s"] - grp[0]["start_s"]) * 1000.0, 1),
            "phones": grp, "is_sil": False,
        })
    return syllables, phones


_JOINT_ALIGN_OUT_NAMES: Tuple[str, ...] = (
    "zh_syl_ctc_logits",
    "phone_frame_logits",
    "phone_ctc_logits",
    "boundary_logits",
    "speech_mask_logit",
    "tone_logits",
    "lang_logits",
)


def _vox2tract_has_joint_align(sess: Any) -> bool:
    out_names = {o.name for o in sess.get_outputs()}
    return all(name in out_names for name in _JOINT_ALIGN_OUT_NAMES)


def run_vox2tract_chunk(
    wav_chunk_16k: np.ndarray,
    f0_norm_chunk: np.ndarray,
    *,
    device: str = "cpu",
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray, str]:
    """Run `Vox2Tract-Lite` ONNX on a single chunk, returning `(tr17, pr1, gl8, h_bb, mel_feats, dev)`."""
    power = ofr.compute_stft_power_50hz(wav_chunk_16k)
    mel_feats = ofr.extract_pure_logmel_50hz(wav_chunk_16k, power=power)
    vq_cues = ofr.extract_vq_cues_50hz(wav_chunk_16k, power=power)
    f0_in = np.asarray(f0_norm_chunk, dtype=np.float32)
    if f0_in.ndim == 1:
        f0_in = f0_in[None, :]
    sess, actual = LOCAL_MODEL_MANAGER.require_session("Vox2Tract-Lite", device=device)
    tr17, pr1, gl8, h_bb = sess.run(
        ["tract17", "pr1", "glot8", "h_backbone"],
        {"mel_feats": mel_feats, "vq_cues": vq_cues, "f0_norm": np.ascontiguousarray(f0_in)},
    )
    return tr17, pr1, gl8, h_bb, mel_feats, actual


def _run_vox2tract_joint_chunk(
    wav_chunk_16k: np.ndarray,
    f0_norm_chunk: np.ndarray,
    *,
    device: str = "cpu",
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, Tuple[np.ndarray, ...], np.ndarray, str]:
    """Run unified `Vox2TractAlign` ONNX in a single pass, returning tract outputs + 7 alignment tensors."""
    power = ofr.compute_stft_power_50hz(wav_chunk_16k)
    mel_feats = ofr.extract_pure_logmel_50hz(wav_chunk_16k, power=power)
    vq_cues = ofr.extract_vq_cues_50hz(wav_chunk_16k, power=power)
    f0_in = np.asarray(f0_norm_chunk, dtype=np.float32)
    if f0_in.ndim == 1:
        f0_in = f0_in[None, :]
    sess, actual = LOCAL_MODEL_MANAGER.require_session("Vox2Tract-Lite", device=device)
    outs = sess.run(
        ["tract17", "pr1", "glot8", "h_backbone", *_JOINT_ALIGN_OUT_NAMES],
        {"mel_feats": mel_feats, "vq_cues": vq_cues, "f0_norm": np.ascontiguousarray(f0_in)},
    )
    return outs[0], outs[1], outs[2], outs[3], tuple(outs[4:]), mel_feats, actual


def _pack_m27_norm(tr17: np.ndarray, f0_norm: np.ndarray, pr1: np.ndarray, gl8: np.ndarray) -> np.ndarray:
    f0 = f0_norm[..., None] if f0_norm.ndim == 2 else f0_norm
    return np.ascontiguousarray(np.concatenate([tr17, f0, pr1, gl8], axis=-1), dtype=np.float32)


def _decode_mandarin_blind_island(
    syl_lp_isl: np.ndarray,
    frame_lp_isl: np.ndarray,
    ctc_lp_isl: np.ndarray,
    bnd_p_isl: np.ndarray,
    sp_p_isl: np.ndarray,
    tone_p_full: np.ndarray,
    *,
    ia: int,
    ib: int,
    n_f: int,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], float]:
    """Decode a Mandarin speech island `[ia, ib)` in blind mode with tone-consistent phoneme templates."""
    ensure_pure_numpy_imports()
    from tt3.mandarin_unt_ipa import ZH_ID_TO_SYL, ZH_SYL_BLANK_ID, add_pinyin_tone_mark, pinyin_to_unt_phones

    ids = syl_lp_isl.argmax(axis=-1)
    py_seq: List[Tuple[str, int]] = []
    prev = ZH_SYL_BLANK_ID
    for t_rel, cid in enumerate(ids.tolist()):
        if cid != prev and cid >= 2 and cid in ZH_ID_TO_SYL:
            py_seq.append((ZH_ID_TO_SYL[cid], t_rel))
        prev = cid
    if not py_seq:
        return [], [], 0.0

    def _build_zh_island_groups(tone_seq: Sequence[int]):
        groups, flat_pids, opt_sil = [], [], []
        for (base_py, _), t_val in zip(py_seq, tone_seq):
            unt_phs = pinyin_to_unt_phones(base_py, tone=t_val)
            pids_s = [ALIGN_V2_IPA_TO_ID[p] for p in unt_phs if p in ALIGN_V2_IPA_TO_ID]
            if not pids_s:
                continue
            groups.append((base_py, t_val, [ALIGN_VOCAB_V2[x] for x in pids_s], pids_s))
            for k_i, pid_x in enumerate(pids_s):
                flat_pids.append(pid_x)
                opt_sil.append(k_i == len(pids_s) - 1)
        return groups, flat_pids, opt_sil

    def _decode_group_tones(groups, spans_loc):
        out_tones: List[int] = []
        cursor = 0
        for _, _, _, pids_s in groups:
            s_first = round(ia * 0.02 + spans_loc[cursor][0], 4)
            e_last = round(ia * 0.02 + spans_loc[cursor + len(pids_s) - 1][1], 4)
            cursor += len(pids_s)
            tf0 = max(0, min(n_f - 1, int(round(s_first / 0.02))))
            tf1 = max(tf0 + 1, min(n_f, int(round(e_last / 0.02))))
            out_tones.append(int(np.argmax(tone_p_full[tf0:tf1, 1:6].mean(axis=0))) + 1)
        return out_tones

    init_tones: List[int] = []
    for idx_py, (_, t_rel) in enumerate(py_seq):
        t_next = py_seq[idx_py + 1][1] if idx_py + 1 < len(py_seq) else (ib - ia)
        ra = max(0, min(ib - ia - 1, t_rel))
        rb = max(ra + 1, min(ib - ia, t_next))
        init_tones.append(int(np.argmax(tone_p_full[ia + ra : ia + rb, 1:6].mean(axis=0))) + 1)

    s_groups_b, f_pids_b, o_sil_b = _build_zh_island_groups(init_tones)
    if not f_pids_b:
        return [], [], 0.0
    sp_loc, sc_loc = _viterbi_guided_align_v2(
        frame_lp_isl, ctc_lp_isl, bnd_p_isl, sp_p_isl, f_pids_b, optional_sil_after=o_sil_b
    )
    refined_tones = _decode_group_tones(s_groups_b, sp_loc)
    if len(refined_tones) == len(py_seq):
        prev_ipas = [g[2] for g in s_groups_b]
        s_groups_2, f_pids_2, o_sil_2 = _build_zh_island_groups(refined_tones)
        if f_pids_2 and [g[2] for g in s_groups_2] != prev_ipas:
            sp_loc_2, sc_loc_2 = _viterbi_guided_align_v2(
                frame_lp_isl, ctc_lp_isl, bnd_p_isl, sp_p_isl, f_pids_2, optional_sil_after=o_sil_2
            )
            tones_after_2 = _decode_group_tones(s_groups_2, sp_loc_2)
            if tones_after_2 == refined_tones:
                s_groups_b, sp_loc, sc_loc = s_groups_2, sp_loc_2, sc_loc_2
            else:
                s_groups_3, f_pids_3, o_sil_3 = _build_zh_island_groups(tones_after_2)
                if f_pids_3:
                    sp_loc, sc_loc = _viterbi_guided_align_v2(
                        frame_lp_isl, ctc_lp_isl, bnd_p_isl, sp_p_isl, f_pids_3, optional_sil_after=o_sil_3
                    )
                    s_groups_b = s_groups_3
        else:
            s_groups_b = [
                (base_py, t_fin, ipas_s, pids_s)
                for (base_py, _, ipas_s, pids_s), t_fin in zip(s_groups_b, refined_tones)
            ]

    syllables_out: List[Dict[str, Any]] = []
    phones_out: List[Dict[str, Any]] = []
    ci = 0
    for base_py, t_num, ipas_s, pids_s in s_groups_b:
        sub_p: List[Dict[str, Any]] = []
        for pid_x, ipa_x in zip(pids_s, ipas_s):
            ls, le, _, lsc = sp_loc[ci]
            ci += 1
            s_abs = round(ia * 0.02 + ls, 4)
            e_abs = round(ia * 0.02 + le, 4)
            ph_o = {
                "ipa": ipa_x, "pid": pid_x, "start_s": s_abs, "end_s": e_abs,
                "dur_ms": round((e_abs - s_abs) * 1000.0, 1),
                "conf": round(float(np.exp(np.clip(lsc, -8.0, 0.0))), 3),
                "is_sil": False, "is_vowel": ipa_x in ALIGN_V2_VOWEL_SET, "lang": "zh",
            }
            sub_p.append(ph_o)
            phones_out.append(ph_o)
        py_mark = add_pinyin_tone_mark(base_py, t_num)
        syllables_out.append({
            "label": py_mark, "sub_label": f"{base_py}{t_num}", "lang": "zh", "tone_id": t_num,
            "start_s": sub_p[0]["start_s"], "end_s": sub_p[-1]["end_s"],
            "dur_ms": round((sub_p[-1]["end_s"] - sub_p[0]["start_s"]) * 1000.0, 1),
            "phones": sub_p, "is_sil": False,
        })
    return syllables_out, phones_out, float(sc_loc)


def analyze_waveform_onnx(
    wav_16k: np.ndarray,
    *,
    text: str = "",
    lang: str = "auto",
    apply_silence_mask: bool = True,
    alignment_mode: Optional[str] = None,
    device: str = "cpu",
) -> Tuple[Dict[str, Any], str]:
    """Pure-ONNX end-to-end `SwiftF0` + `Vox2Tract-Lite` + `Vox2Align-Lite v2` analysis."""
    ensure_pure_numpy_imports()
    from kf_ipa_synth.m27_contract import denormalize_m27, normalize_f0_m27
    from tt3.mandarin_unt_ipa import ZH_ID_TO_SYL, ZH_SYL_BLANK_ID, add_pinyin_tone_mark, pinyin_to_unt_phones

    t0 = time.perf_counter()
    w = np.asarray(wav_16k, dtype=np.float32).reshape(-1)
    n_f = len(w) // ofr.HOP_SAMPLES_16K
    if n_f < 4:
        return {"ok": False, "error": "音频过短（不足 80 ms）"}, "cpu"
    w = np.ascontiguousarray(w[: n_f * ofr.HOP_SAMPLES_16K], dtype=np.float32)
    total_sec = n_f * 0.02

    # Ensure required models are enabled up-front before running work
    vt_sess, actual_dev = LOCAL_MODEL_MANAGER.require_session("Vox2Tract-Lite", device=device)
    joint_align = _vox2tract_has_joint_align(vt_sess)
    del vt_sess
    need_align = alignment_mode != "none" or apply_silence_mask
    has_custom_aligner = (
        LOCAL_MODEL_MANAGER.is_enabled("Vox2Align-Lite v2")
        and LOCAL_MODEL_MANAGER.slot_status("Vox2Align-Lite v2").get("source") == "external"
    )
    use_joint_align = (
        joint_align
        and not has_custom_aligner
        and (
            alignment_mode in ("guided", "blind")
            or (need_align and LOCAL_MODEL_MANAGER.is_enabled("Vox2Align-Lite v2"))
        )
    )
    v2_sess = None
    if need_align and not use_joint_align:
        if (alignment_mode == "guided" and not joint_align) or LOCAL_MODEL_MANAGER.is_enabled("Vox2Align-Lite v2"):
            v2_sess, _ = LOCAL_MODEL_MANAGER.require_session("Vox2Align-Lite v2", device=device)

    f0_hz, vm_f0 = extract_swift_f0_50hz(w, fmin=46.875, fmax=2093.75, num_frames=n_f)
    f0_norm = normalize_f0_m27(f0_hz)
    f0_align_norm = normalize_f0_m27(np.clip(f0_hz, 55.0, 550.0))

    t_net = time.perf_counter()
    cached_full_mel: Optional[np.ndarray] = None
    joint_align_outputs: Optional[Tuple[np.ndarray, ...]] = None
    if n_f <= 240:
        if use_joint_align:
            tr17, pr1, gl8, h_bb, joint_align_outputs, cached_full_mel, actual_dev = _run_vox2tract_joint_chunk(
                w, f0_norm, device=device
            )
        else:
            tr17, pr1, gl8, h_bb, cached_full_mel, actual_dev = run_vox2tract_chunk(w, f0_norm, device=device)
        m27_norm = _pack_m27_norm(tr17, f0_norm[None, :], pr1, gl8)
        m27_norm_for_v2 = _pack_m27_norm(tr17, f0_align_norm[None, :], pr1, gl8)
    else:
        chunks = ofr.plan_silence_chunks(w, sr=ofr.SAMPLE_RATE_16K, max_chunk_sec=4.8, min_chunk_sec=1.6, target_chunk_sec=3.8)
        ctx_f = 20
        h_parts, m_parts, mv2_parts = [], [], []
        j_parts: List[List[np.ndarray]] = [[] for _ in range(len(_JOINT_ALIGN_OUT_NAMES))]
        for ch in chunks:
            f0_i = int(ch["start_16k"]) // ofr.HOP_SAMPLES_16K
            f1_i = int(ch["end_16k"]) // ofr.HOP_SAMPLES_16K
            if f1_i <= f0_i:
                continue
            cf0 = max(0, f0_i - ctx_f)
            cf1 = min(n_f, f1_i + ctx_f)
            if use_joint_align:
                tr_c, pr_c, gl_c, h_c, j_c, _, actual_dev = _run_vox2tract_joint_chunk(
                    w[cf0 * ofr.HOP_SAMPLES_16K : cf1 * ofr.HOP_SAMPLES_16K],
                    f0_norm[cf0:cf1],
                    device=device,
                )
            else:
                tr_c, pr_c, gl_c, h_c, _, actual_dev = run_vox2tract_chunk(
                    w[cf0 * ofr.HOP_SAMPLES_16K : cf1 * ofr.HOP_SAMPLES_16K],
                    f0_norm[cf0:cf1],
                    device=device,
                )
                j_c = None
            s_off = f0_i - cf0
            s_end = s_off + (f1_i - f0_i)
            h_parts.append(h_c[:, s_off:s_end])
            m_parts.append(_pack_m27_norm(tr_c[:, s_off:s_end], f0_norm[None, f0_i:f1_i], pr_c[:, s_off:s_end], gl_c[:, s_off:s_end]))
            mv2_parts.append(_pack_m27_norm(tr_c[:, s_off:s_end], f0_align_norm[None, f0_i:f1_i], pr_c[:, s_off:s_end], gl_c[:, s_off:s_end]))
            if j_c is not None:
                for ji, arr_j in enumerate(j_c):
                    j_parts[ji].append(arr_j[:, s_off:s_end])
        h_bb = np.concatenate(h_parts, axis=1)
        m27_norm = np.concatenate(m_parts, axis=1)
        m27_norm_for_v2 = np.concatenate(mv2_parts, axis=1)
        if use_joint_align and j_parts[0]:
            joint_align_outputs = tuple(np.concatenate(parts, axis=1) for parts in j_parts)
    t_vt = time.perf_counter()

    if joint_align_outputs is not None:
        syl_lp = _log_softmax(joint_align_outputs[0][0], axis=-1)
        frame_lp = _log_softmax(joint_align_outputs[1][0], axis=-1)
        ctc_lp = _log_softmax(joint_align_outputs[2][0], axis=-1)
        bnd_p = _sigmoid(joint_align_outputs[3][0])
        sp_p = _sigmoid(joint_align_outputs[4][0])
        tone_p = _softmax(joint_align_outputs[5][0], axis=-1)
        lang_p = _softmax(joint_align_outputs[6][0], axis=-1)
    elif v2_sess is not None:
        v2_out_names = [
            "zh_syl_ctc_logits", "phone_frame_logits", "phone_ctc_logits",
            "boundary_logits", "speech_mask_logit", "tone_logits", "lang_logits",
        ]
        if n_f <= 480:
            mel_v2 = cached_full_mel if cached_full_mel is not None else ofr.extract_pure_logmel_50hz(w)
            outs = v2_sess.run(
                v2_out_names,
                {
                    "mel_feats": np.ascontiguousarray(mel_v2, dtype=np.float32),
                    "h_backbone": np.ascontiguousarray(h_bb, dtype=np.float32),
                    "m27_norm": np.ascontiguousarray(m27_norm_for_v2, dtype=np.float32),
                },
            )
            syl_lp = _log_softmax(outs[0][0], axis=-1)
            frame_lp = _log_softmax(outs[1][0], axis=-1)
            ctc_lp = _log_softmax(outs[2][0], axis=-1)
            bnd_p = _sigmoid(outs[3][0])
            sp_p = _sigmoid(outs[4][0])
            tone_p = _softmax(outs[5][0], axis=-1)
            lang_p = _softmax(outs[6][0], axis=-1)
        else:
            v2_chunks = ofr.plan_silence_chunks(w, sr=ofr.SAMPLE_RATE_16K, max_chunk_sec=9.6, min_chunk_sec=3.0, target_chunk_sec=7.5)
            ctx_v2 = 25
            syl_l, frm_l, ctc_l, bnd_l, sp_l, ton_l, lng_l = [], [], [], [], [], [], []
            for ch in v2_chunks:
                f0_i = int(ch["start_16k"]) // ofr.HOP_SAMPLES_16K
                f1_i = int(ch["end_16k"]) // ofr.HOP_SAMPLES_16K
                if f1_i <= f0_i:
                    continue
                cf0 = max(0, f0_i - ctx_v2)
                cf1 = min(n_f, f1_i + ctx_v2)
                mel_c = ofr.extract_pure_logmel_50hz(w[cf0 * ofr.HOP_SAMPLES_16K : cf1 * ofr.HOP_SAMPLES_16K])
                outs_c = v2_sess.run(
                    v2_out_names,
                    {
                        "mel_feats": np.ascontiguousarray(mel_c, dtype=np.float32),
                        "h_backbone": np.ascontiguousarray(h_bb[:, cf0:cf1], dtype=np.float32),
                        "m27_norm": np.ascontiguousarray(m27_norm_for_v2[:, cf0:cf1], dtype=np.float32),
                    },
                )
                s_off = f0_i - cf0
                s_end = s_off + (f1_i - f0_i)
                syl_l.append(_log_softmax(outs_c[0][0, s_off:s_end], axis=-1))
                frm_l.append(_log_softmax(outs_c[1][0, s_off:s_end], axis=-1))
                ctc_l.append(_log_softmax(outs_c[2][0, s_off:s_end], axis=-1))
                bnd_l.append(_sigmoid(outs_c[3][0, s_off:s_end]))
                sp_l.append(_sigmoid(outs_c[4][0, s_off:s_end]))
                ton_l.append(_softmax(outs_c[5][0, s_off:s_end], axis=-1))
                lng_l.append(_softmax(outs_c[6][0, s_off:s_end], axis=-1))
            syl_lp = np.concatenate(syl_l, axis=0)
            frame_lp = np.concatenate(frm_l, axis=0)
            ctc_lp = np.concatenate(ctc_l, axis=0)
            bnd_p = np.concatenate(bnd_l, axis=0)
            sp_p = np.concatenate(sp_l, axis=0)
            tone_p = np.concatenate(ton_l, axis=0)
            lang_p = np.concatenate(lng_l, axis=0)
    else:
        syl_lp = np.zeros((n_f, 415), dtype=np.float32)
        frame_lp = np.zeros((n_f, len(ALIGN_VOCAB_V2)), dtype=np.float32)
        ctc_lp = np.zeros((n_f, len(ALIGN_VOCAB_V2)), dtype=np.float32)
        bnd_p = np.zeros((n_f, 2), dtype=np.float32)
        sp_p = _quiet_pause_speech_mask(w) if apply_silence_mask else np.ones(n_f, dtype=np.float32)
        tone_p = np.zeros((n_f, 8), dtype=np.float32)
        lang_p = np.zeros((n_f, 3), dtype=np.float32)
    t_al = time.perf_counter()

    m27_raw = denormalize_m27(m27_norm[0])
    m27_masked, smooth_gate = apply_speech_mask_to_m27(m27_raw, sp_p)

    sil_idx = sp_p < 0.35
    if int(np.sum(sil_idx)) >= 3:
        tongue_cols = [8, 9, 10, 11]
        raw_sil_jitter = float(np.mean(np.std(m27_raw[sil_idx][:, tongue_cols], axis=0)))
        msk_sil_jitter = float(np.mean(np.std(m27_masked[sil_idx][:, tongue_cols], axis=0)))
    else:
        raw_sil_jitter = msk_sil_jitter = 0.0

    text_clean = unicodedata.normalize("NFKC", text or "").replace("’", "'").strip()
    mode = alignment_mode or ("guided" if text_clean else "blind")
    if v2_sess is None and joint_align_outputs is None:
        mode = "none"
    alignment_error = _validate_guided_text(text_clean) if mode == "guided" else None
    align_score = 0.0
    phones: List[Dict[str, Any]] = []
    syllables: List[Dict[str, Any]] = []
    english_word_spans: List[Tuple[float, float, str]] = []

    if mode == "guided" and not alignment_error:
        syl_groups, flat_pids, opt_sil = _text_to_v2_target_hierarchy(text_clean, lang=lang)
        if alignment_mode == "guided":
            han = re.findall(r"[\u4e00-\u9fff]", text_clean)
            aligned_han = re.findall(r"[\u4e00-\u9fff]", "".join(g["text"] for g in syl_groups))
            if not flat_pids or han != aligned_han or any(
                g["lang"] not in ("zh", "en") or (lang != "auto" and g["lang"] != lang) for g in syl_groups
            ):
                alignment_error = {"code": "unsupported_text", "hint": "原文无法转换为所选语言可用的普通话或英语音素"}
            elif len(flat_pids) > n_f:
                alignment_error = {"code": "text_too_long", "hint": "原文的音素数超过录音可用帧数，请核对原文或分段对齐"}
            elif float(np.max(np.abs(w))) < 1e-5 or np.count_nonzero(sp_p >= 0.42) < 2:
                alignment_error = {"code": "no_speech", "hint": "模型未检测到可对齐的语音，请检查录音和所选范围"}
        elif not flat_pids:
            mode = "blind"

    if mode == "guided" and not alignment_error:
        spans, align_score = _viterbi_guided_align_v2(frame_lp, ctc_lp, bnd_p[:, 0], sp_p, flat_pids, optional_sil_after=opt_sil)
        if alignment_mode == "guided" and (
            not np.isfinite(align_score) or align_score < -1e12 or len(spans) != len(flat_pids)
            or any(end <= start for start, end, _, _ in spans)
        ):
            alignment_error = {"code": "alignment_failed", "hint": "模型无法为原文匹配完整的音素边界，请核对原文与录音"}
    if alignment_error:
        mode = "none"

    if mode == "guided":
        cur_idx = 0
        for sg in syl_groups:
            sub_phones: List[Dict[str, Any]] = []
            for pid, ipa_s in zip(sg["pids"], sg["ipas"]):
                s_s, e_s, _, sc = spans[cur_idx]
                cur_idx += 1
                ph_obj = {
                    "ipa": ipa_s, "pid": pid,
                    "start_s": round(s_s, 4), "end_s": round(e_s, 4),
                    "dur_ms": round((e_s - s_s) * 1000.0, 1),
                    "conf": round(float(np.exp(np.clip(sc, -8.0, 0.0))), 3),
                    "is_sil": False, "is_vowel": ipa_s in ALIGN_V2_VOWEL_SET,
                    "lang": sg["lang"],
                }
                sub_phones.append(ph_obj)
                phones.append(ph_obj)
            lbl = sg["text"]
            if sg["pinyin"] and sg["lang"] == "zh":
                lbl = f"{sg['text']} ({sg['pinyin']})" if sg["text"] != sg["pinyin"] else sg["pinyin"]
            if sg["lang"] == "en":
                english_word_spans.append((sub_phones[0]["start_s"], sub_phones[-1]["end_s"], lbl))
                groups = _split_aligned_english_word(sub_phones)
            else:
                groups = [sub_phones]
            for group in groups:
                start, end = group[0]["start_s"], group[-1]["end_s"]
                label = lbl if len(groups) == 1 else "/" + "".join(p["ipa"] for p in group) + "/"
                syllables.append({
                    "label": label, "sub_label": sg["pinyin"] or sg["tone"], "lang": sg["lang"],
                    "start_s": start, "end_s": end, "dur_ms": round((end - start) * 1000.0, 1),
                    "phones": group, "is_sil": False,
                    **({"word": lbl} if sg["lang"] == "en" else {}),
                })
    elif mode == "blind":
        islands: List[Tuple[int, int]] = []
        in_isl, i0, sil_run = False, 0, 0
        for t in range(n_f):
            if sp_p[t] >= 0.38:
                if not in_isl:
                    i0 = max(0, t - 1)
                    in_isl = True
                sil_run = 0
            elif in_isl:
                sil_run += 1
                if sil_run >= 6:
                    islands.append((i0, min(n_f, t - sil_run + 2)))
                    in_isl = False
        if in_isl:
            islands.append((i0, n_f))

        for ia, ib in islands:
            if ib - ia < 3:
                continue
            if float(lang_p[ia:ib, ALANG_ZH].sum()) >= float(lang_p[ia:ib, ALANG_EN].sum()):
                zh_syls, zh_phs, sc_loc = _decode_mandarin_blind_island(
                    syl_lp[ia:ib],
                    frame_lp[ia:ib],
                    ctc_lp[ia:ib],
                    bnd_p[ia:ib, 0],
                    sp_p[ia:ib],
                    tone_p,
                    ia=ia,
                    ib=ib,
                    n_f=n_f,
                )
                if zh_syls:
                    align_score = sc_loc
                    syllables.extend(zh_syls)
                    phones.extend(zh_phs)
            else:
                en_syls, en_phs = _blind_decode_en_island(frame_lp[ia:ib], bnd_p[ia:ib], sp_p[ia:ib], tone_p[ia:ib], t_offset=ia)
                syllables.extend(en_syls)
                phones.extend(en_phs)

    sp_spans: List[Tuple[float, float, str]] = []
    in_sp = bool(sp_p[0] >= 0.42)
    s0 = 0
    for fi in range(1, n_f):
        cur_sp = bool(sp_p[fi] >= 0.42)
        if cur_sp != in_sp:
            sp_spans.append((s0 * 0.02, fi * 0.02, "speech" if in_sp else "sil"))
            s0 = fi
            in_sp = cur_sp
    sp_spans.append((s0 * 0.02, n_f * 0.02, "speech" if in_sp else "sil"))

    tg_str = _export_praat_textgrid(
        total_sec, syllables, phones, speech_spans=sp_spans, english_word_spans=english_word_spans
    ) if mode != "none" else ""
    if joint_align_outputs is not None:
        v2_file = LOCAL_MODEL_MANAGER.active_path("Vox2Tract-Lite").name
        align_ver = "joint-v4" if "v4" in v2_file.lower() else "joint-v3"
        align_step = 10000 if align_ver == "joint-v4" else 35000
    else:
        v2_file = LOCAL_MODEL_MANAGER.active_path("Vox2Align-Lite v2").name
        align_ver = "v2"
        align_step = 20000
    return {
        "ok": True,
        "mode": mode,
        "alignment_error": alignment_error,
        "model_meta": {"version": align_ver, "step": align_step, "file": v2_file, "runtime": "onnx"},
        "total_sec": round(total_sec, 3),
        "n_frames": n_f,
        "vt_ms": round((t_vt - t_net) * 1000.0, 1),
        "align_ms": round((t_al - t_vt) * 1000.0, 1),
        "total_ms": round((time.perf_counter() - t0) * 1000.0, 1),
        "align_score": round(align_score, 3),
        "syllables": syllables,
        "phones": phones,
        "speech_mask": [round(float(x), 3) for x in smooth_gate],
        "phone_bnd_prob": [round(float(x), 3) for x in bnd_p[:, 0]],
        "syl_bnd_prob": [round(float(x), 3) for x in bnd_p[:, 1]],
        "f0_hz": [round(float(f0_hz[i]), 1) if vm_f0[i] else 0.0 for i in range(n_f)],
        "tract_compare": {
            "t": [round((i + 0.5) * 0.02, 3) for i in range(n_f)],
            "raw_ttx": [round(float(v), 3) for v in m27_raw[:, 10]],
            "raw_tty": [round(float(v), 3) for v in m27_raw[:, 11]],
            "raw_tcx": [round(float(v), 3) for v in m27_raw[:, 8]],
            "raw_tcy": [round(float(v), 3) for v in m27_raw[:, 9]],
            "masked_ttx": [round(float(v), 3) for v in m27_masked[:, 10]],
            "masked_tty": [round(float(v), 3) for v in m27_masked[:, 11]],
            "masked_tcx": [round(float(v), 3) for v in m27_masked[:, 8]],
            "masked_tcy": [round(float(v), 3) for v in m27_masked[:, 9]],
            "raw_sil_jitter_cm": round(raw_sil_jitter, 4),
            "masked_sil_jitter_cm": round(msk_sil_jitter, 4),
        },
        "m27_phys": m27_masked if apply_silence_mask else m27_raw,
        "textgrid": tg_str,
    }, actual_dev


# ---------------------------------------------------------------------------
# 7. Text2Prosody-Lite (ONNX, zero-torch)
# ---------------------------------------------------------------------------

_VOWEL_CHARS = set("aeiouyɑæɐɒɔəɚɛɜɝɤɨɪɵøœʉʊʌɿʅʮʯ")
_LANG_ZH, _LANG_EN, _LANG_IPA = 1, 2, 3
_TONE_NONE, _TONE_ZH_1, _TONE_ZH_2, _TONE_ZH_3, _TONE_ZH_4, _TONE_ZH_5 = 0, 1, 2, 3, 4, 5
_STRESS_EN_1, _STRESS_EN_2, _STRESS_EN_0 = 7, 8, 9
_PUNCT_NONE, _PUNCT_COMMA, _PUNCT_PERIOD, _PUNCT_QUESTION, _PUNCT_EXCLAIM = 0, 1, 2, 3, 4
_ROLE_NORMAL = 0
_DUR_REF_MS, _PAUSE_REF_MS = 80.0, 120.0
_PUNCT_MAP = {
    ",": _PUNCT_COMMA, "，": _PUNCT_COMMA, "、": _PUNCT_COMMA, ";": _PUNCT_COMMA, "；": _PUNCT_COMMA, ":": _PUNCT_COMMA, "：": _PUNCT_COMMA,
    ".": _PUNCT_PERIOD, "。": _PUNCT_PERIOD,
    "?": _PUNCT_QUESTION, "？": _PUNCT_QUESTION,
    "!": _PUNCT_EXCLAIM, "！": _PUNCT_EXCLAIM,
}
_ZH_TONE_TO_ID = {
    "55": _TONE_ZH_1, "35": _TONE_ZH_2, "214": _TONE_ZH_3, "21": _TONE_ZH_3, "51": _TONE_ZH_4, "0": _TONE_ZH_5,
    "1": _TONE_ZH_1, "2": _TONE_ZH_2, "3": _TONE_ZH_3, "4": _TONE_ZH_4, "5": _TONE_ZH_5,
}
_ZH_DIPHTHONG_MERGE = {
    ("a", "ɪ"): "aɪ", ("ɑ", "ɪ"): "aɪ", ("a", "ʊ"): "aʊ", ("ɑ", "ʊ"): "aʊ",
    ("e", "ɪ"): "eɪ", ("ɛ", "ɪ"): "eɪ", ("o", "ʊ"): "oʊ", ("ə", "ʊ"): "oʊ", ("ɤ", "ʊ"): "oʊ",
}


def _semitone_rel_to_hz(st: np.ndarray, base_hz: float) -> np.ndarray:
    safe_base = max(1e-3, float(base_hz))
    st_c = np.clip(np.asarray(st, dtype=np.float64), -14.0, 16.0)
    return np.maximum(safe_base * (2.0 ** (st_c / 12.0)), 1e-3).astype(np.float32)


def _extract_punct_by_syllable(text: str, n_syls: int) -> Tuple[List[int], int]:
    punct_by_syl = [_PUNCT_NONE] * max(1, n_syls)
    s = (text or "").strip()
    utt_punct = _PUNCT_PERIOD
    for ch in reversed(s):
        if ch in _PUNCT_MAP:
            utt_punct = _PUNCT_MAP[ch]
            break
        if ch.strip():
            break
    tokens = re.findall(r"\[[^\]]+\]|[\u4e00-\u9fff]|[A-Za-z]+(?:'[A-Za-z]+)?|[,，、;；:：.。?？!！]", s)
    cur_idx = -1
    content_cnt = sum(1 for t in tokens if t not in _PUNCT_MAP)
    for tok in tokens:
        if tok in _PUNCT_MAP:
            if cur_idx >= 0 and content_cnt > 0:
                mapped = min(n_syls - 1, max(0, int(round((cur_idx + 1) * n_syls / content_cnt)) - 1))
                punct_by_syl[mapped] = _PUNCT_MAP[tok]
        else:
            cur_idx += 1
    if n_syls > 0 and punct_by_syl[-1] == _PUNCT_NONE:
        punct_by_syl[-1] = utt_punct
    return punct_by_syl, utt_punct


def predict_prosody_timeline_onnx(
    text: str,
    *,
    lang: str = "zh",
    base_f0: float = 165.0,
    speed_scale: float = 1.0,
    pitch_scale: float = 1.35,
    tone_sandhi: bool = True,
) -> Dict[str, Any]:
    """Pure-ONNX equivalent of `ProsodyPredictor.predict_timeline`."""
    ensure_pure_numpy_imports()
    from kf_ipa_synth.phonetics import ipa_to_phon_features, ipa_to_phon_features_32, is_ipa_voiced
    from kf_ipa_synth.text2ipa import convert_text_to_timeline

    t0 = time.perf_counter()
    sess, _ = LOCAL_MODEL_MANAGER.require_session("Text2Prosody-Lite", device="cpu")
    pf_shape = sess.get_inputs()[0].shape
    phon_feat_dim = int(pf_shape[2]) if (len(pf_shape) >= 3 and isinstance(pf_shape[2], int) and pf_shape[2] in (22, 32)) else 22
    tl_rule = convert_text_to_timeline(text, lang=lang, bpm=108.0, base_f0=float(base_f0), tone_sandhi=tone_sandhi)
    kfs_rule: List[Dict[str, Any]] = [dict(k) for k in tl_rule.get("keyframes", [])]
    syls: List[Dict[str, Any]] = tl_rule.get("syllables", [])
    syl_by_id = {str(s["id"]): (idx, s) for idx, s in enumerate(syls)}
    n_syls = max(1, len(syls))
    punct_by_syl, utt_punct = _extract_punct_by_syllable(text, n_syls)

    logical_phones: List[Dict[str, Any]] = []
    i = 0
    while i < len(kfs_rule):
        kf = kfs_rule[i]
        ipa = str(kf.get("ipa", ""))
        role = str(kf.get("role", "normal"))
        if ipa in ("sil", "") or role == "silence":
            i += 1
            continue
        member_idxs = [i]
        sid_str = str(kf.get("syl_id", ""))
        syl_idx, s_obj = syl_by_id.get(sid_str, (0, {}))
        s_lang = str(s_obj.get("lang", lang)).lower()
        lid = _LANG_ZH if s_lang.startswith("zh") else (_LANG_EN if s_lang.startswith("en") else _LANG_IPA)
        if role == "closure" and (i + 1) < len(kfs_rule):
            nxt = kfs_rule[i + 1]
            if str(nxt.get("role", "")) in ("release", "aspiration") and str(nxt.get("syl_id", "")) == sid_str:
                member_idxs.append(i + 1)
                i += 1
        elif lid == _LANG_ZH and (i + 1) < len(kfs_rule):
            nxt = kfs_rule[i + 1]
            n_ipa = str(nxt.get("ipa", ""))
            if str(nxt.get("syl_id", "")) == sid_str and (ipa, n_ipa) in _ZH_DIPHTHONG_MERGE:
                ipa = _ZH_DIPHTHONG_MERGE[(ipa, n_ipa)]
                member_idxs.append(i + 1)
                i += 1

        if lid == _LANG_ZH:
            tid = _ZH_TONE_TO_ID.get(str(s_obj.get("tone", "55")), _TONE_ZH_1)
        elif lid == _LANG_EN:
            t_str = str(s_obj.get("tone", ""))
            if "主" in t_str or "1" in t_str or float(kf.get("f0_hz", base_f0)) > base_f0 * 1.05:
                tid = _STRESS_EN_1
            elif "次" in t_str or "2" in t_str:
                tid = _STRESS_EN_2
            else:
                tid = _STRESS_EN_0
        else:
            tid = _TONE_NONE

        logical_phones.append({
            "ipa": ipa, "member_idxs": member_idxs, "syl_idx": syl_idx,
            "lang_id": lid, "tone_id": tid,
            "is_vowel": any(ch in _VOWEL_CHARS for ch in ipa),
            "syl_text": str(s_obj.get("text", ipa)),
        })
        i += 1

    if not logical_phones:
        return {"ok": False, "error": "文本未能解析出有效音素"}

    n_phones = len(logical_phones)
    syl_to_lps: Dict[int, List[int]] = defaultdict(list)
    for li, lp in enumerate(logical_phones):
        syl_to_lps[lp["syl_idx"]].append(li)
    syl_ids_sorted = sorted(syl_to_lps.keys())
    n_s = max(1, len(syl_ids_sorted))
    syl_rank = {sid: k for k, sid in enumerate(syl_ids_sorted)}

    phrase_groups: List[List[int]] = [[]]
    for sid in syl_ids_sorted:
        phrase_groups[-1].append(sid)
        if sid < len(punct_by_syl) and punct_by_syl[sid] != _PUNCT_NONE:
            phrase_groups.append([])
    if not phrase_groups[-1]:
        phrase_groups.pop()
    syl_phrase_pos: Dict[int, float] = {}
    for grp in phrase_groups:
        denom = max(1, len(grp) - 1)
        for k, sid in enumerate(grp):
            syl_phrase_pos[sid] = float(k) / float(denom) if len(grp) > 1 else 1.0

    phon_feat = np.zeros((1, n_phones, phon_feat_dim), dtype=np.float32)
    pos_struct = np.zeros((1, n_phones, 10), dtype=np.float32)
    lang_arr = np.zeros((1, n_phones), dtype=np.int64)
    tone_arr = np.zeros((1, n_phones), dtype=np.int64)
    punct_arr = np.zeros((1, n_phones), dtype=np.int64)
    role_arr = np.full((1, n_phones), _ROLE_NORMAL, dtype=np.int64)
    log_utt_syls = float(np.clip(np.log(max(1, n_s)) / np.log(32.0), 0.0, 1.0))

    for li, lp in enumerate(logical_phones):
        sid = lp["syl_idx"]
        s_lps = syl_to_lps[sid]
        p_pos = float(s_lps.index(li)) / float(max(1, len(s_lps) - 1)) if len(s_lps) > 1 else 0.5
        r_s = syl_rank[sid]
        u_pos = float(r_s) / float(max(1, n_s - 1)) if n_s > 1 else 0.5
        sw_pos = float(r_s % 2) if n_s > 1 else 0.5
        log_w = float(np.clip(np.log(2.0) / np.log(8.0), 0.0, 1.0)) if n_s > 1 else 0.0
        p_code = punct_by_syl[sid] if sid < len(punct_by_syl) else _PUNCT_NONE
        is_syl_end = li == s_lps[-1]
        brk_minor = 1.0 if (is_syl_end and p_code >= _PUNCT_COMMA) else 0.0
        brk_major = 1.0 if (is_syl_end and p_code in (_PUNCT_PERIOD, _PUNCT_QUESTION, _PUNCT_EXCLAIM)) else 0.0
        phon_feat[0, li] = ipa_to_phon_features_32(lp["ipa"]) if phon_feat_dim == 32 else ipa_to_phon_features(lp["ipa"])
        pos_struct[0, li] = np.array(
            [0.0, 1.0 if lp["is_vowel"] else 0.0, p_pos, sw_pos, syl_phrase_pos.get(sid, u_pos), u_pos, log_utt_syls, log_w, brk_minor, brk_major],
            dtype=np.float32,
        )
        lang_arr[0, li] = lp["lang_id"]
        tone_arr[0, li] = lp["tone_id"]
        is_last_two = (n_s - 1 - r_s) <= 1
        if is_syl_end and p_code != _PUNCT_NONE:
            punct_arr[0, li] = p_code
        elif is_last_two and utt_punct in (_PUNCT_QUESTION, _PUNCT_EXCLAIM):
            punct_arr[0, li] = utt_punct
        elif li == n_phones - 1:
            punct_arr[0, li] = utt_punct

    t_net = time.perf_counter()
    log_dur_o, f0_st3_o, voiced_lgt_o, pause_lgt_o, log_pause_o = sess.run(
        ["log_dur", "f0_st3", "voiced_logit", "pause_logit", "log_pause_dur"],
        {
            "phon_feat": phon_feat, "pos_struct": pos_struct,
            "lang_id": lang_arr, "tone_stress_id": tone_arr,
            "punct_id": punct_arr, "role_id": role_arr,
        },
    )
    prosody_ms = (time.perf_counter() - t_net) * 1000.0

    pred_dur_ms = np.clip(_DUR_REF_MS * np.exp(log_dur_o[0]) / max(0.4, float(speed_scale)), 25.0, 750.0)
    pred_st3 = f0_st3_o[0] * float(pitch_scale)
    pred_voi = _sigmoid(voiced_lgt_o[0])
    pred_p_prob = _sigmoid(pause_lgt_o[0])
    pred_p_ms = np.clip(_PAUSE_REF_MS * np.exp(log_pause_o[0]) / max(0.4, float(speed_scale)), 55.0, 480.0)

    kfs_neural: List[Dict[str, Any]] = [
        {"ipa": "sil", "duration_ms": 60, "f0_hz": round(float(base_f0), 1), "phonation": "auto", "role": "silence", "syl_id": ""}
    ]
    f0_knots_neural: List[Dict[str, float]] = []
    cursor_s = 0.060
    phone_cards: List[Dict[str, Any]] = []

    for li, lp in enumerate(logical_phones):
        total_d = float(pred_dur_ms[li])
        hz3 = _semitone_rel_to_hz(pred_st3[li], base_f0)
        is_v = bool(pred_voi[li] >= 0.40 or lp["is_vowel"])
        mid_hz = float(hz3[1])
        m_idxs = lp["member_idxs"]
        if len(m_idxs) == 2:
            k0, k1 = dict(kfs_rule[m_idxs[0]]), dict(kfs_rule[m_idxs[1]])
            r_sum = max(1.0, float(k0.get("duration_ms", 50)) + float(k1.get("duration_ms", 50)))
            ratio0 = float(np.clip(float(k0.get("duration_ms", 50)) / r_sum, 0.35, 0.68))
            d0 = max(25.0, round(total_d * ratio0, 1))
            d1 = max(20.0, round(total_d - d0, 1))
            k0["duration_ms"], k1["duration_ms"] = int(round(d0)), int(round(d1))
            if lp["is_vowel"]:
                k0["f0_hz"], k1["f0_hz"] = round(float(hz3[0]), 1), round(float(hz3[2]), 1)
            else:
                k0["f0_hz"] = k1["f0_hz"] = round(mid_hz, 1)
            kfs_neural.extend([k0, k1])
            actual_d = (k0["duration_ms"] + k1["duration_ms"]) / 1000.0
        else:
            k0 = dict(kfs_rule[m_idxs[0]])
            k0["duration_ms"] = int(round(total_d))
            k0["f0_hz"] = round(mid_hz, 1)
            kfs_neural.append(k0)
            actual_d = k0["duration_ms"] / 1000.0

        sid_cur = lp["syl_idx"]
        s_lps_cur = syl_to_lps[sid_cur]
        is_onset_cons = (not lp["is_vowel"]) and (li == s_lps_cur[0]) and any(logical_phones[x]["is_vowel"] for x in s_lps_cur)
        if is_v and not is_onset_cons and (lp["is_vowel"] or is_ipa_voiced(lp["ipa"])):
            for frac, hz_v in ((0.12, float(hz3[0])), (0.50, float(hz3[1])), (0.88, float(hz3[2]))):
                f0_knots_neural.append({"t": round(cursor_s + frac * actual_d, 4), "hz": round(hz_v, 1)})

        phone_cards.append({
            "ipa": lp["ipa"], "syl_text": lp["syl_text"],
            "lang": "zh" if lp["lang_id"] == _LANG_ZH else ("en" if lp["lang_id"] == _LANG_EN else "ipa"),
            "start_s": round(cursor_s, 4), "end_s": round(cursor_s + actual_d, 4),
            "dur_ms": round(actual_d * 1000.0, 1),
            "f0_start": round(float(hz3[0]), 1), "f0_mid": round(float(hz3[1]), 1), "f0_end": round(float(hz3[2]), 1),
            "voiced": is_v,
        })
        cursor_s += actual_d

        sid = lp["syl_idx"]
        is_syl_end = li == syl_to_lps[sid][-1]
        p_code = punct_by_syl[sid] if sid < len(punct_by_syl) else _PUNCT_NONE
        if li < n_phones - 1 and is_syl_end and (p_code != _PUNCT_NONE or pred_p_prob[li] >= 0.88):
            p_ms = int(round(max(110.0, float(pred_p_ms[li])) if p_code != _PUNCT_NONE else float(pred_p_ms[li])))
            kfs_neural.append({"ipa": "sil", "duration_ms": p_ms, "f0_hz": round(mid_hz, 1), "phonation": "auto", "role": "silence", "syl_id": ""})
            phone_cards.append({"ipa": "sil", "syl_text": "停", "lang": "sil", "start_s": round(cursor_s, 4), "end_s": round(cursor_s + p_ms / 1000.0, 4), "dur_ms": float(p_ms), "voiced": False})
            cursor_s += p_ms / 1000.0

    kfs_neural.append({"ipa": "sil", "duration_ms": 80, "f0_hz": round(float(base_f0), 1), "phonation": "auto", "role": "silence", "syl_id": ""})
    cursor_s += 0.080

    rule_pts: List[Dict[str, float]] = []
    r_cur = 0.0
    for kf in kfs_rule:
        dm = float(kf.get("duration_ms", 80)) / 1000.0
        if str(kf.get("ipa", "")) not in ("sil", "") and str(kf.get("role", "")) != "silence":
            rule_pts.append({"t": round(r_cur + 0.5 * dm, 4), "hz": round(float(kf.get("f0_hz", base_f0)), 1)})
        r_cur += dm

    return {
        "ok": True,
        "model_meta": {"file": LOCAL_MODEL_MANAGER.active_path("Text2Prosody-Lite").name, "runtime": "onnx"},
        "prosody_cpu_ms": round(prosody_ms, 2),
        "total_prep_ms": round((time.perf_counter() - t0) * 1000.0, 1),
        "neural_total_sec": round(cursor_s, 3),
        "rule_total_sec": round(r_cur, 3),
        "keyframes_neural": kfs_neural,
        "f0_knots_neural": f0_knots_neural,
        "keyframes_rule": kfs_rule,
        "f0_knots_rule": tl_rule.get("f0_points", rule_pts),
        "syllables": syls,
        "phone_cards": phone_cards,
        "rule_curve": rule_pts,
    }


__all__ = [
    "ModelUnloadedError",
    "analyze_waveform_onnx",
    "apply_soft_onset_200hz",
    "apply_speech_mask_to_m27",
    "apply_unreleased_zero_pressure_200hz",
    "denoise_channel_dpdfnet",
    "enforce_release_modes_50hz",
    "ensure_pure_numpy_imports",
    "extract_speaker_embedding",
    "extract_swift_f0_50hz",
    "load_speaker_profile_embedding",
    "predict_ipa2tract",
    "predict_prosody_timeline_onnx",
    "predict_tract_area_cm2",
    "run_vox2tract_chunk",
    "synthesize_tract2vox",
]
