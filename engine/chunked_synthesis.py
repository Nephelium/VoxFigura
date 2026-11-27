"""Smart <=10s chunking, overlap-add seamless stitching, per-chunk BLAKE2b LRU cache,
multi-core parallel execution, and streaming chunk generator for zero-PyTorch ONNX synthesis.
"""
from __future__ import annotations

from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
import hashlib
import threading
import time
from typing import Any, Dict, Iterator, List, Optional, Sequence, Tuple

import numpy as np
from scipy.signal import resample_poly

from model_registry_runtime import (
    LOCAL_MODEL_MANAGER,
    PARALLEL_CHUNK_WORKERS,
)
import onnx_frontends as ofr

CONTROL_HZ_50 = 50
SAMPLE_RATE_16K = 16000
SAMPLE_RATE_48K = 48000
HOP_16K = 320  # 20 ms @ 16 kHz
HOP_48K = 960  # 20 ms @ 48 kHz

DEFAULT_MAX_CHUNK_FRAMES = 500      # 10.0 s soft limit @ 50 Hz
DEFAULT_HARD_MAX_FRAMES = 600       # 12.0 s hard limit @ 50 Hz
DEFAULT_MIN_CHUNK_FRAMES = 150      # 3.0 s minimum chunk unless total is shorter
DEFAULT_FIRST_STREAM_FRAMES = 250   # 5.0 s target first chunk for ~100-150 ms TTFA
MIN_TAIL_FRAMES = 50                # 1.0 s minimum trailing chunk

IPA_OVERLAP_FRAMES = 25             # 0.50 s left/right context for IPA2Tract-Lite
IPA_BLEND_FRAMES = 3                # 60 ms cosine blend on non-silence IPA cuts
VOCODER_CTX_FRAMES = 10             # 0.20 s left/right context for Tract2Vox-Lite
VOCODER_XFADE_SAMPLES_16K = 320     # 20 ms @ 16 kHz crossfade on non-silence cuts
VOCODER_ALIGN_MAX_LAG_16K = 64      # +/- 4 ms pitch-period cross-correlation search
STREAM_OVERLAP_SAMPLES_48K = 480    # 10 ms @ 48 kHz overlap for non-silence stream cuts

SILENCE_PR_DPA_THRESHOLD = 15.0     # <= 1.5 Pa considered silence valley
MIN_SILENCE_RUN_FRAMES = 4          # >= 80 ms clean pause for sentence-level caching


@dataclass(frozen=True)
class ChunkSpec:
    index: int
    start_frame: int
    end_frame: int
    left_is_silence: bool
    right_is_silence: bool
    cut_reason: str

    @property
    def num_frames(self) -> int:
        return self.end_frame - self.start_frame


class _BoundedBytesLRU:
    """Thread-safe bounded LRU cache storing float32 numpy arrays keyed by content hash."""

    def __init__(self, max_entries: int = 160, max_bytes: int = 96 * 1024 * 1024) -> None:
        self._lock = threading.Lock()
        self._max_entries = max_entries
        self._max_bytes = max_bytes
        self._store: OrderedDict[str, Tuple[np.ndarray, int]] = OrderedDict()
        self._total_bytes = 0
        self._hits = 0
        self._misses = 0

    def get(self, key: str) -> Optional[np.ndarray]:
        with self._lock:
            item = self._store.get(key)
            if item is None:
                self._misses += 1
                return None
            self._store.move_to_end(key)
            self._hits += 1
            return item[0]

    def put(self, key: str, arr: np.ndarray) -> None:
        val = np.ascontiguousarray(arr, dtype=np.float32)
        nbytes = int(val.nbytes)
        if nbytes > self._max_bytes:
            return
        with self._lock:
            prev = self._store.pop(key, None)
            if prev is not None:
                self._total_bytes -= prev[1]
            self._store[key] = (val, nbytes)
            self._total_bytes += nbytes
            while len(self._store) > self._max_entries or self._total_bytes > self._max_bytes:
                _, (_, evicted_bytes) = self._store.popitem(last=False)
                self._total_bytes -= evicted_bytes

    def clear(self) -> None:
        with self._lock:
            self._store.clear()
            self._total_bytes = 0

    def stats(self) -> Dict[str, int]:
        with self._lock:
            return {
                "entries": len(self._store),
                "bytes": self._total_bytes,
                "hits": self._hits,
                "misses": self._misses,
            }


_VOCODER_CACHE = _BoundedBytesLRU(max_entries=160, max_bytes=96 * 1024 * 1024)
_IPA_CACHE = _BoundedBytesLRU(max_entries=128, max_bytes=48 * 1024 * 1024)


def clear_synthesis_caches() -> None:
    _VOCODER_CACHE.clear()
    _IPA_CACHE.clear()


def get_synthesis_cache_stats() -> Dict[str, Dict[str, int]]:
    return {
        "vocoder": _VOCODER_CACHE.stats(),
        "ipa2tract": _IPA_CACHE.stats(),
    }


def _extract_span_markers_50hz(
    articulation_spans: Optional[Sequence[Dict[str, Any]]],
    step_hz: int,
    n_frames: int,
) -> Tuple[List[Tuple[int, int]], List[Tuple[int, int]], List[int]]:
    """Convert articulation_spans (at step_hz) into 50 Hz sil intervals, stop closure intervals, and boundary frames."""
    sil_intervals: List[Tuple[int, int]] = []
    closure_intervals: List[Tuple[int, int]] = []
    boundaries: List[int] = []
    if not articulation_spans:
        return sil_intervals, closure_intervals, boundaries
    scale = float(CONTROL_HZ_50) / float(max(1, step_hz))
    for sp in articulation_spans:
        if not isinstance(sp, dict):
            continue
        a_raw = sp.get("start_frame")
        b_raw = sp.get("end_frame")
        if type(a_raw) is not int or type(b_raw) is not int or b_raw <= a_raw:
            continue
        a = max(0, min(n_frames, int(round(a_raw * scale))))
        b = max(a, min(n_frames, int(round(b_raw * scale))))
        if b <= a:
            continue
        phase = str(sp.get("phase") or "normal")
        ipa = str(sp.get("ipa") or "").strip().lower()
        if phase == "silence" or ipa in ("sil", "sp", "pau", ""):
            sil_intervals.append((a, b))
        elif phase == "closure":
            closure_intervals.append((a, b))
        boundaries.append(a)
        boundaries.append(b)
    return sil_intervals, closure_intervals, sorted(set(boundaries))


def _find_pressure_silence_runs(pr_dpa: np.ndarray, min_run: int = MIN_SILENCE_RUN_FRAMES) -> List[Tuple[int, int]]:
    silent = pr_dpa <= SILENCE_PR_DPA_THRESHOLD
    if not np.any(silent):
        return []
    padded = np.concatenate(([False], silent, [False]))
    diff = np.diff(padded.astype(np.int8))
    starts = np.flatnonzero(diff == 1)
    ends = np.flatnonzero(diff == -1)
    return [(int(a), int(b)) for a, b in zip(starts, ends) if (b - a) >= min_run]


def plan_control_chunks(
    m27_50hz_dpa: np.ndarray,
    *,
    articulation_spans: Optional[Sequence[Dict[str, Any]]] = None,
    step_hz: int = 200,
    max_frames: int = DEFAULT_MAX_CHUNK_FRAMES,
    hard_max_frames: int = DEFAULT_HARD_MAX_FRAMES,
    min_frames: int = DEFAULT_MIN_CHUNK_FRAMES,
    first_chunk_max_frames: Optional[int] = None,
    split_on_pauses: bool = True,
) -> List[ChunkSpec]:
    """Plan smart <=10s chunks aligned to pauses/punctuation/silences/closures for caching & streaming.

    Strategy:
      1. If there are natural internal silence gaps (`sil` spans or `PR <= 1.5 Pa` for >= 80 ms)
         and `split_on_pauses=True`, cut cleanly at pause midpoints once a chunk reaches `min_frames`.
         This yields 0-artifact seams AND enables per-sentence content-hash caching on edits.
      2. If speech is continuous beyond `max_frames` (10 s), search `[65%, 100%]` of the target window
         preferring: `sil` span -> `PR` silence run -> stop `closure` -> phone boundary -> lowest tract velocity.
    """
    arr = np.asarray(m27_50hz_dpa, dtype=np.float32)
    n_frames = int(arr.shape[0])
    if n_frames <= 0:
        return []

    first_limit = min(max_frames, first_chunk_max_frames) if first_chunk_max_frames else max_frames
    if n_frames <= min_frames or (not split_on_pauses and n_frames <= first_limit):
        return [ChunkSpec(0, 0, n_frames, True, True, "whole")]

    pr_dpa = arr[:, 18] if arr.shape[1] >= 19 else np.full(n_frames, 700.0, dtype=np.float32)
    tract_vel = np.zeros(n_frames, dtype=np.float32)
    if n_frames > 1 and arr.shape[1] >= 17:
        diffs = np.abs(np.diff(arr[:, :17], axis=0)).mean(axis=1)
        tract_vel[1:] = diffs
        tract_vel[0] = diffs[0]
    norm_pr = np.clip(pr_dpa / 8000.0, 0.0, 1.5)
    energy_score = tract_vel + 0.35 * norm_pr

    sil_spans, closure_spans, boundaries = _extract_span_markers_50hz(articulation_spans, step_hz, n_frames)
    pr_sil_runs = _find_pressure_silence_runs(pr_dpa, min_run=MIN_SILENCE_RUN_FRAMES)

    chunks: List[ChunkSpec] = []
    pos = 0
    prev_is_sil = True

    while pos < n_frames:
        rem = n_frames - pos
        is_first = len(chunks) == 0
        target_max = first_limit if is_first else max_frames
        target_hard = min(hard_max_frames, first_limit + 50) if (is_first and first_chunk_max_frames) else hard_max_frames
        target_min = min(min_frames, max(50, target_max // 2))

        # Check if remaining fits cleanly without needing forced cut
        if rem <= target_max:
            if not split_on_pauses or rem < target_min + MIN_TAIL_FRAMES:
                chunks.append(ChunkSpec(len(chunks), pos, n_frames, prev_is_sil, True, "whole" if not chunks else "tail"))
                break
            # Even if remaining <= target_max, split on a clean internal pause (>= 80 ms) for sentence-level caching
            win_lo = pos + target_min
            win_hi = n_frames - MIN_TAIL_FRAMES
            pause_cut: Optional[Tuple[int, str]] = None
            best_len = 0
            for a, b in sil_spans:
                mid = (a + b) // 2
                if win_lo <= mid <= win_hi and (b - a) >= MIN_SILENCE_RUN_FRAMES:
                    if (b - a) > best_len:
                        best_len = b - a
                        pause_cut = (mid, "silence_span")
            if pause_cut is None:
                for a, b in pr_sil_runs:
                    mid = (a + b) // 2
                    if win_lo <= mid <= win_hi and (b - a) > best_len:
                        best_len = b - a
                        pause_cut = (mid, "pressure_silence")
            if pause_cut is None:
                chunks.append(ChunkSpec(len(chunks), pos, n_frames, prev_is_sil, True, "whole" if not chunks else "tail"))
                break
            cut, reason = pause_cut
            chunks.append(ChunkSpec(len(chunks), pos, cut, prev_is_sil, True, reason))
            pos = cut
            prev_is_sil = True
            continue

        # Remaining exceeds target_max; if <= target_hard and no clean pause exists, absorb to avoid tiny stub
        win_lo = pos + max(target_min, int(target_max * 0.60))
        win_hi = min(n_frames - MIN_TAIL_FRAMES, pos + target_max)
        if win_hi <= win_lo:
            win_lo = pos + max(MIN_TAIL_FRAMES, target_max // 2)
            win_hi = min(n_frames - MIN_TAIL_FRAMES, pos + target_max)
        if win_hi <= pos + MIN_TAIL_FRAMES:
            chunks.append(ChunkSpec(len(chunks), pos, n_frames, prev_is_sil, True, "tail"))
            break

        pref = pos + int(target_max * 0.85)
        chosen_cut: Optional[int] = None
        chosen_sil = False
        chosen_reason = "hard_limit"

        # Priority 1a: explicit sil span inside [pos + target_min, win_hi]
        wide_lo = pos + target_min
        sil_cands = [
            ((a + b) // 2, b - a)
            for a, b in sil_spans
            if wide_lo <= (a + b) // 2 <= win_hi and (b - a) >= 2
        ]
        if sil_cands:
            # Prefer longest pause closest to pref
            chosen_cut = max(sil_cands, key=lambda item: (item[1] * 4.0 - abs(item[0] - pref) * 0.15))[0]
            chosen_sil = True
            chosen_reason = "silence_span"

        # Priority 1b: PR <= 1.5 Pa silence run inside [pos + target_min, win_hi]
        if chosen_cut is None:
            pr_cands = [
                ((a + b) // 2, b - a)
                for a, b in pr_sil_runs
                if wide_lo <= (a + b) // 2 <= win_hi
            ]
            if pr_cands:
                chosen_cut = max(pr_cands, key=lambda item: (item[1] * 4.0 - abs(item[0] - pref) * 0.15))[0]
                chosen_sil = True
                chosen_reason = "pressure_silence"

        # If remaining <= target_hard and no silence found, absorb whole remaining cleanly
        if chosen_cut is None and rem <= target_hard:
            chunks.append(ChunkSpec(len(chunks), pos, n_frames, prev_is_sil, True, "tail"))
            break

        # Priority 2: stop closure span in [win_lo, win_hi]
        if chosen_cut is None:
            cl_cands = [
                (a + b) // 2
                for a, b in closure_spans
                if win_lo <= (a + b) // 2 <= win_hi
            ]
            if cl_cands:
                chosen_cut = min(cl_cands, key=lambda c: float(energy_score[c]) + abs(c - pref) * 0.001)
                chosen_sil = bool(pr_dpa[chosen_cut] <= SILENCE_PR_DPA_THRESHOLD)
                chosen_reason = "stop_closure"

        # Priority 3: articulation phone/syllable boundary in [win_lo, win_hi]
        if chosen_cut is None:
            bnd_cands = [c for c in boundaries if win_lo <= c <= win_hi]
            if bnd_cands:
                chosen_cut = min(bnd_cands, key=lambda c: float(energy_score[c]) + abs(c - pref) * 0.001)
                chosen_sil = bool(pr_dpa[chosen_cut] <= SILENCE_PR_DPA_THRESHOLD)
                chosen_reason = "phone_boundary"

        # Priority 4: lowest tract velocity + PR frame in [win_lo, win_hi]
        if chosen_cut is None:
            sub = energy_score[win_lo : win_hi + 1]
            best_rel = int(np.argmin(sub))
            chosen_cut = win_lo + best_rel
            chosen_sil = bool(pr_dpa[chosen_cut] <= SILENCE_PR_DPA_THRESHOLD)
            chosen_reason = "low_velocity"

        chunks.append(ChunkSpec(len(chunks), pos, chosen_cut, prev_is_sil, chosen_sil, chosen_reason))
        pos = chosen_cut
        prev_is_sil = chosen_sil

    return chunks


# ---------------------------------------------------------------------------
# Chunked + Cached IPA2Tract-Lite
# ---------------------------------------------------------------------------

def _hash_ipa_chunk(
    model_ver: str,
    alpha: float,
    pad_l: int,
    pad_r: int,
    cond_slice: np.ndarray,
    base_slice: np.ndarray,
) -> str:
    h = hashlib.blake2b(digest_size=16)
    h.update(model_ver.encode("utf-8"))
    h.update(f"|a={alpha:.6f}|l={pad_l}|r={pad_r}|".encode("ascii"))
    h.update(np.ascontiguousarray(cond_slice, dtype=np.float32).tobytes())
    h.update(np.ascontiguousarray(base_slice, dtype=np.float32).tobytes())
    return h.hexdigest()


def _adapt_ipa_cond_dim(c: np.ndarray, expected_dim: int) -> np.ndarray:
    """Adapt `cond` last dim cleanly between legacy 111-ch (22d phon) and v4 121-ch (32d phon).

    Layout: [0:88 geometry/f0/phase/events] + [88:88+P phon_feat] + [88+P has_phon].
    """
    cur_dim = int(c.shape[-1])
    if cur_dim == expected_dim:
        return c
    if cur_dim == 111 and expected_dim == 121:
        pad = np.zeros(c.shape[:-1] + (10,), dtype=np.float32)
        return np.ascontiguousarray(np.concatenate([c[..., :110], pad, c[..., 110:111]], axis=-1), dtype=np.float32)
    if cur_dim == 121 and expected_dim == 111:
        return np.ascontiguousarray(np.concatenate([c[..., :110], c[..., 120:121]], axis=-1), dtype=np.float32)
    return c


def predict_ipa2tract_chunked(
    cond_111: np.ndarray,
    x_base_26: np.ndarray,
    alpha: float = 1.0,
    *,
    articulation_spans: Optional[Sequence[Dict[str, Any]]] = None,
    step_hz: int = 200,
    max_frames: int = DEFAULT_MAX_CHUNK_FRAMES,
) -> np.ndarray:
    """Run `IPA2Tract-Lite` with <=10s chunking, 0.5s overlap context, and per-chunk hash cache."""
    c = np.asarray(cond_111, dtype=np.float32)
    b = np.asarray(x_base_26, dtype=np.float32)
    squeeze = c.ndim == 2
    if squeeze:
        c = c[None, :, :]
        b = b[None, :, :]

    bsz, n_frames, _ = c.shape
    sess, _ = LOCAL_MODEL_MANAGER.require_session("IPA2Tract-Lite", device="cpu")
    cond_shape = sess.get_inputs()[0].shape
    if len(cond_shape) >= 3 and isinstance(cond_shape[2], int) and cond_shape[2] in (111, 121):
        c = _adapt_ipa_cond_dim(c, int(cond_shape[2]))
    model_ver = LOCAL_MODEL_MANAGER.model_version_key("IPA2Tract-Lite")
    a_arr = np.array([float(alpha)], dtype=np.float32)

    if bsz > 1 or n_frames <= DEFAULT_MIN_CHUNK_FRAMES:
        key = _hash_ipa_chunk(model_ver, float(alpha), 0, 0, c, b)
        cached = _IPA_CACHE.get(key)
        if cached is not None and cached.shape == (bsz, n_frames, 26):
            return cached[0].copy() if squeeze else cached.copy()
        out = sess.run(
            ["x_hat"],
            {"cond": np.ascontiguousarray(c), "x_base": np.ascontiguousarray(b), "alpha": a_arr},
        )[0]
        _IPA_CACHE.put(key, out)
        return out[0] if squeeze else out

    # Reconstruct approximate M27 (dPa) pressure proxy from cond_111's is_sil / normalized x_base_26
    # Column 17 in x_base_26 is normalized PR in [-1, 1] -> [0, 16000 dPa]
    proxy_m27 = np.zeros((n_frames, 27), dtype=np.float32)
    proxy_m27[:, :17] = b[0, :, :17]
    proxy_m27[:, 18] = np.clip((b[0, :, 17] + 1.0) * 8000.0, 0.0, 16000.0)
    chunks = plan_control_chunks(
        proxy_m27,
        articulation_spans=articulation_spans,
        step_hz=step_hz,
        max_frames=max_frames,
        split_on_pauses=True,
    )
    if len(chunks) == 1:
        key = _hash_ipa_chunk(model_ver, float(alpha), 0, 0, c, b)
        cached = _IPA_CACHE.get(key)
        if cached is not None and cached.shape == (1, n_frames, 26):
            return cached[0].copy() if squeeze else cached.copy()
        out = sess.run(
            ["x_hat"],
            {"cond": np.ascontiguousarray(c), "x_base": np.ascontiguousarray(b), "alpha": a_arr},
        )[0]
        _IPA_CACHE.put(key, out)
        return out[0] if squeeze else out

    out_full = np.empty((1, n_frames, 26), dtype=np.float32)
    chunk_outputs: List[Tuple[ChunkSpec, np.ndarray, int, int]] = []
    for ch in chunks:
        pad_l = min(IPA_OVERLAP_FRAMES, ch.start_frame)
        pad_r = min(IPA_OVERLAP_FRAMES, n_frames - ch.end_frame)
        sl_a = ch.start_frame - pad_l
        sl_b = ch.end_frame + pad_r
        c_sl = np.ascontiguousarray(c[:, sl_a:sl_b, :], dtype=np.float32)
        b_sl = np.ascontiguousarray(b[:, sl_a:sl_b, :], dtype=np.float32)
        key = _hash_ipa_chunk(model_ver, float(alpha), pad_l, pad_r, c_sl, b_sl)
        pred = _IPA_CACHE.get(key)
        if pred is None or pred.shape != (1, sl_b - sl_a, 26):
            pred = sess.run(["x_hat"], {"cond": c_sl, "x_base": b_sl, "alpha": a_arr})[0]
            _IPA_CACHE.put(key, pred)
        chunk_outputs.append((ch, pred, pad_l, pad_r))

    for idx, (ch, pred, pad_l, _) in enumerate(chunk_outputs):
        core = pred[:, pad_l : pad_l + ch.num_frames, :]
        out_full[:, ch.start_frame : ch.end_frame, :] = core
        # Cosine blend across non-silence cut with previous chunk
        if idx > 0 and not ch.left_is_silence:
            prev_ch, prev_pred, prev_pad_l, prev_pad_r = chunk_outputs[idx - 1]
            blend_n = min(IPA_BLEND_FRAMES, prev_pad_r, pad_l, ch.num_frames, prev_ch.num_frames)
            if blend_n > 0:
                u = (np.arange(blend_n, dtype=np.float32) + 0.5) / float(blend_n)
                w = (0.5 * (1.0 - np.cos(np.pi * u)))[None, :, None]
                prev_tail = prev_pred[:, prev_pad_l + prev_ch.num_frames : prev_pad_l + prev_ch.num_frames + blend_n, :]
                curr_head = core[:, :blend_n, :]
                out_full[:, ch.start_frame : ch.start_frame + blend_n, :] = (1.0 - w) * prev_tail + w * curr_head

    return out_full[0] if squeeze else out_full


# ---------------------------------------------------------------------------
# Chunked + Cached + Parallel + Phase-Aligned Tract2Vox-Lite
# ---------------------------------------------------------------------------

def _normalize_spk_seq(spk_emb_or_seq: np.ndarray, bsz: int, n_frames: int) -> np.ndarray:
    spk = np.asarray(spk_emb_or_seq, dtype=np.float32)
    if spk.ndim == 1:
        spk_seq = np.repeat(spk[None, None, :], n_frames, axis=1)
    elif spk.ndim == 2:
        if spk.shape[0] == n_frames and spk.shape[1] == 512:
            spk_seq = spk[None, :, :]
        elif spk.shape[-1] == 512:
            spk_seq = np.repeat(spk[:, None, :], n_frames, axis=1)
        else:
            raise ValueError(f"说话人声纹维度无效：{spk.shape}")
    else:
        spk_seq = spk[:, :n_frames, :]
    if spk_seq.shape[0] == 1 and bsz > 1:
        spk_seq = np.repeat(spk_seq, bsz, axis=0)
    return np.ascontiguousarray(spk_seq, dtype=np.float32)


def _hash_vocoder_chunk(
    model_ver: str,
    seed: int,
    ctx_l: int,
    ctx_r: int,
    m27_slice: np.ndarray,
    spk_slice: np.ndarray,
) -> str:
    h = hashlib.blake2b(digest_size=16)
    h.update(model_ver.encode("utf-8"))
    h.update(f"|s={seed}|l={ctx_l}|r={ctx_r}|".encode("ascii"))
    h.update(np.ascontiguousarray(m27_slice, dtype=np.float32).tobytes())
    h.update(np.ascontiguousarray(spk_slice, dtype=np.float32).tobytes())
    return h.hexdigest()


def _run_vocoder_slice(
    sess: Any,
    m27_slice: np.ndarray,
    spk_slice: np.ndarray,
    *,
    seed: int,
) -> np.ndarray:
    n_sl = int(m27_slice.shape[1])
    env_rand, n_wb = ofr.make_vocoder_noise(n_sl, batch_size=1, seed=seed)
    wav = sess.run(
        ["wav_16k"],
        {
            "m27_norm": np.ascontiguousarray(m27_slice, dtype=np.float32),
            "spk_seq": np.ascontiguousarray(spk_slice, dtype=np.float32),
            "env_rand": env_rand,
            "n_wb": n_wb,
        },
    )[0]
    return np.ascontiguousarray(wav[0], dtype=np.float32)


def _best_phase_lag(ref_tail: np.ndarray, cand_buf: np.ndarray, center_offset: int, max_lag: int) -> int:
    """Find integer lag in [-max_lag, +max_lag] maximizing normalized correlation to align pitch pulses."""
    n = len(ref_tail)
    if n < 16 or len(cand_buf) < center_offset + n + max_lag or center_offset < max_lag:
        return 0
    ref_norm = float(np.linalg.norm(ref_tail))
    if ref_norm < 1e-5:
        return 0
    best_lag = 0
    best_score = -2.0
    for lag in range(-max_lag, max_lag + 1):
        seg = cand_buf[center_offset + lag : center_offset + lag + n]
        seg_norm = float(np.linalg.norm(seg))
        if seg_norm < 1e-5:
            continue
        score = float(np.dot(ref_tail, seg)) / (ref_norm * seg_norm)
        if score > best_score:
            best_score = score
            best_lag = lag
    return best_lag


def stitch_vocoder_chunks_16k(
    chunk_results: Sequence[Tuple[ChunkSpec, np.ndarray, int, int]],
    total_frames: int,
) -> np.ndarray:
    """Seamlessly stitch synthesized 16 kHz chunks into an exact `(total_frames * 320,)` float32 waveform."""
    total_samples = total_frames * HOP_16K
    out = np.zeros(total_samples, dtype=np.float32)

    for idx, (ch, wav_full, ctx_l, ctx_r) in enumerate(chunk_results):
        s0 = ctx_l * HOP_16K
        n_core = ch.num_frames * HOP_16K
        dst_a = ch.start_frame * HOP_16K
        dst_b = ch.end_frame * HOP_16K

        if idx == 0 or ch.left_is_silence:
            core = wav_full[s0 : s0 + n_core]
            out[dst_a:dst_b] = core
            # On silence cut, apply ultra-short 32-sample (2 ms) anti-click guard at seam if non-zero
            if idx > 0 and n_core >= 32 and dst_a >= 32:
                prev_end = float(out[dst_a - 1])
                curr_start = float(out[dst_a])
                if abs(prev_end - curr_start) > 0.02:
                    taper = np.linspace(0.0, 1.0, 32, dtype=np.float32)
                    out[dst_a - 32 : dst_a] *= 1.0 - taper
                    out[dst_a : dst_a + 32] *= taper
            continue

        # Non-silence seam: overlap-add with pitch-period phase alignment over VOCODER_XFADE_SAMPLES_16K
        prev_ch, prev_wav, prev_ctx_l, prev_ctx_r = chunk_results[idx - 1]
        prev_end_in_full = (prev_ctx_l + prev_ch.num_frames) * HOP_16K
        ov = min(
            VOCODER_XFADE_SAMPLES_16K,
            prev_ctx_r * HOP_16K,
            s0,
            n_core,
        )
        if ov >= 64:
            ref_tail = prev_wav[prev_end_in_full : prev_end_in_full + ov]
            max_lag = min(VOCODER_ALIGN_MAX_LAG_16K, s0, max(0, len(wav_full) - (s0 + n_core)))
            lag = _best_phase_lag(ref_tail, wav_full, s0, max_lag) if max_lag >= 4 else 0
            shifted_s0 = max(0, min(len(wav_full) - n_core, s0 + lag))
            core = wav_full[shifted_s0 : shifted_s0 + n_core]
            out[dst_a:dst_b] = core
            u = (np.arange(ov, dtype=np.float32) + 0.5) / float(ov)
            w = 0.5 * (1.0 - np.cos(np.pi * u))
            out[dst_a : dst_a + ov] = (1.0 - w) * ref_tail + w * core[:ov]
        else:
            out[dst_a:dst_b] = wav_full[s0 : s0 + n_core]

    return out


def synthesize_tract2vox_chunked(
    m27_norm: np.ndarray,
    spk_emb_or_seq: np.ndarray,
    *,
    m27_phys_dpa: Optional[np.ndarray] = None,
    articulation_spans: Optional[Sequence[Dict[str, Any]]] = None,
    step_hz: int = 200,
    device: str = "cpu",
    seed: int = 20261122,
    max_frames: int = DEFAULT_MAX_CHUNK_FRAMES,
    allow_parallel: bool = True,
) -> Tuple[np.ndarray, str, Dict[str, Any]]:
    """Synthesize 16 kHz waveform with <=10s smart chunking, per-chunk hash cache, and multi-core parallelism."""
    t0 = time.perf_counter()
    m27 = np.asarray(m27_norm, dtype=np.float32)
    if m27.ndim == 2:
        m27 = m27[None, :, :]
    bsz, n_frames, _ = m27.shape
    spk_seq = _normalize_spk_seq(spk_emb_or_seq, bsz, n_frames)

    if m27_phys_dpa is None:
        # Derive physical PR (dPa) proxy from normalized col 18 in [-1, 1] -> [0, 16000]
        phys = np.zeros((n_frames, 27), dtype=np.float32)
        phys[:, :17] = m27[0, :, :17]
        phys[:, 18] = np.clip((m27[0, :, 18] + 1.0) * 8000.0, 0.0, 16000.0)
    else:
        phys = np.asarray(m27_phys_dpa, dtype=np.float32)

    chunks = plan_control_chunks(
        phys,
        articulation_spans=articulation_spans,
        step_hz=step_hz,
        max_frames=max_frames,
        split_on_pauses=True,
    )

    model_ver = LOCAL_MODEL_MANAGER.model_version_key("Tract2Vox-Lite")
    # Ensure slot is enabled (raises ModelUnloadedError immediately even if cache would hit!)
    primary_sess, actual_dev = LOCAL_MODEL_MANAGER.require_session("Tract2Vox-Lite", device=device)

    results: List[Optional[Tuple[ChunkSpec, np.ndarray, int, int]]] = [None] * len(chunks)
    misses: List[Tuple[int, ChunkSpec, int, int, np.ndarray, np.ndarray, str]] = []
    cache_hits = 0

    for idx, ch in enumerate(chunks):
        ctx_l = min(VOCODER_CTX_FRAMES, ch.start_frame)
        ctx_r = min(VOCODER_CTX_FRAMES, n_frames - ch.end_frame)
        sl_a = ch.start_frame - ctx_l
        sl_b = ch.end_frame + ctx_r
        m_sl = np.ascontiguousarray(m27[:, sl_a:sl_b, :], dtype=np.float32)
        s_sl = np.ascontiguousarray(spk_seq[:, sl_a:sl_b, :], dtype=np.float32)
        key = _hash_vocoder_chunk(model_ver, seed, ctx_l, ctx_r, m_sl, s_sl)
        cached = _VOCODER_CACHE.get(key)
        expected_len = (sl_b - sl_a) * HOP_16K
        if cached is not None and len(cached) == expected_len:
            results[idx] = (ch, cached, ctx_l, ctx_r)
            cache_hits += 1
        else:
            misses.append((idx, ch, ctx_l, ctx_r, m_sl, s_sl, key))

    workers_used = 1
    if len(misses) >= 2 and allow_parallel and PARALLEL_CHUNK_WORKERS >= 2 and actual_dev == "cpu":
        worker_sessions, actual_dev = LOCAL_MODEL_MANAGER.require_parallel_sessions(
            "Tract2Vox-Lite", min(PARALLEL_CHUNK_WORKERS, len(misses)), device=device
        )
        workers_used = len(worker_sessions)
        sess_locks = [threading.Lock() for _ in worker_sessions]

        def _worker_task(item_idx_in_misses: int, item: Tuple[int, ChunkSpec, int, int, np.ndarray, np.ndarray, str]) -> Tuple[int, ChunkSpec, np.ndarray, int, int]:
            idx, ch, ctx_l, ctx_r, m_sl, s_sl, key = item
            slot_i = item_idx_in_misses % len(worker_sessions)
            with sess_locks[slot_i]:
                wav = _run_vocoder_slice(worker_sessions[slot_i], m_sl, s_sl, seed=seed)
            _VOCODER_CACHE.put(key, wav)
            return idx, ch, wav, ctx_l, ctx_r

        with ThreadPoolExecutor(max_workers=workers_used) as pool:
            futs = [pool.submit(_worker_task, mi, item) for mi, item in enumerate(misses)]
            for fut in futs:
                idx, ch, wav, ctx_l, ctx_r = fut.result()
                results[idx] = (ch, wav, ctx_l, ctx_r)
    else:
        for idx, ch, ctx_l, ctx_r, m_sl, s_sl, key in misses:
            wav = _run_vocoder_slice(primary_sess, m_sl, s_sl, seed=seed)
            _VOCODER_CACHE.put(key, wav)
            results[idx] = (ch, wav, ctx_l, ctx_r)

    final_results = [r for r in results if r is not None]
    stitched = stitch_vocoder_chunks_16k(final_results, n_frames)
    stats = {
        "total_chunks": len(chunks),
        "cache_hits": cache_hits,
        "parallel_workers": workers_used,
        "wall_ms": round((time.perf_counter() - t0) * 1000.0, 1),
        "cut_reasons": [ch.cut_reason for ch in chunks],
    }
    return stitched, actual_dev, stats


def iter_tract2vox_chunks_48k_stream(
    m27_norm: np.ndarray,
    spk_emb_or_seq: np.ndarray,
    *,
    m27_phys_dpa: np.ndarray,
    lead_frames: int,
    tail_frames: int,
    sample_count_48k: int,
    articulation_spans: Optional[Sequence[Dict[str, Any]]] = None,
    step_hz: int = 200,
    device: str = "cpu",
    seed: int = 20261122,
    first_chunk_max_frames: int = DEFAULT_FIRST_STREAM_FRAMES,
    max_frames: int = DEFAULT_MAX_CHUNK_FRAMES,
) -> Iterator[Dict[str, Any]]:
    """Stream 48 kHz chunks in playback order: chunk 0 runs immediately while remaining chunks run in parallel.

    Each yielded chunk has exact 48 kHz samples aligned to the global timeline (`[start_sample, start_sample + sample_count)`),
    with context-padded polyphase upsampling (`resample_poly(3, 1)`) so there are zero resampling edge clicks.
    Non-silence boundaries carry a 10 ms (`480`-sample) overlap head so the Web Audio scheduler crossfades seamlessly.
    """
    m27 = np.asarray(m27_norm, dtype=np.float32)
    if m27.ndim == 2:
        m27 = m27[None, :, :]
    n_total_frames = int(m27.shape[1])
    n_core_frames = n_total_frames - lead_frames - tail_frames
    spk_seq = _normalize_spk_seq(spk_emb_or_seq, 1, n_total_frames)

    core_phys = np.asarray(m27_phys_dpa, dtype=np.float32)
    chunks = plan_control_chunks(
        core_phys,
        articulation_spans=articulation_spans,
        step_hz=step_hz,
        max_frames=max_frames,
        first_chunk_max_frames=first_chunk_max_frames,
        split_on_pauses=True,
    )

    model_ver = LOCAL_MODEL_MANAGER.model_version_key("Tract2Vox-Lite")
    primary_sess, actual_dev = LOCAL_MODEL_MANAGER.require_session("Tract2Vox-Lite", device=device)

    use_parallel = len(chunks) >= 2 and PARALLEL_CHUNK_WORKERS >= 2 and actual_dev == "cpu"
    worker_sessions = (
        LOCAL_MODEL_MANAGER.require_parallel_sessions("Tract2Vox-Lite", min(PARALLEL_CHUNK_WORKERS, len(chunks)), device=device)[0]
        if use_parallel
        else [primary_sess]
    )
    sess_locks = [threading.Lock() for _ in worker_sessions]

    def _compute_one(ch: ChunkSpec, worker_idx: int) -> Tuple[np.ndarray, int, bool, float]:
        t_ch = time.perf_counter()
        abs_a = lead_frames + ch.start_frame
        abs_b = lead_frames + ch.end_frame
        ctx_l = min(VOCODER_CTX_FRAMES, abs_a)
        ctx_r = min(VOCODER_CTX_FRAMES, n_total_frames - abs_b)
        sl_a = abs_a - ctx_l
        sl_b = abs_b + ctx_r
        m_sl = np.ascontiguousarray(m27[:, sl_a:sl_b, :], dtype=np.float32)
        s_sl = np.ascontiguousarray(spk_seq[:, sl_a:sl_b, :], dtype=np.float32)
        key = _hash_vocoder_chunk(model_ver, seed, ctx_l, ctx_r, m_sl, s_sl)
        cached = _VOCODER_CACHE.get(key)
        expected_len = (sl_b - sl_a) * HOP_16K
        if cached is not None and len(cached) == expected_len:
            return cached, ctx_l, True, round((time.perf_counter() - t_ch) * 1000.0, 1)
        slot_i = worker_idx % len(worker_sessions)
        with sess_locks[slot_i]:
            wav16 = _run_vocoder_slice(worker_sessions[slot_i], m_sl, s_sl, seed=seed)
        _VOCODER_CACHE.put(key, wav16)
        return wav16, ctx_l, False, round((time.perf_counter() - t_ch) * 1000.0, 1)

    yield {
        "type": "plan",
        "total_chunks": len(chunks),
        "parallel_workers": len(worker_sessions),
        "device_effective": actual_dev,
        "cut_reasons": [ch.cut_reason for ch in chunks],
    }

    # Kick off chunks 1..K-1 on background pool while running chunk 0 immediately for lowest TTFA
    pool = ThreadPoolExecutor(max_workers=len(worker_sessions)) if len(chunks) > 1 else None
    bg_futures: Dict[int, Any] = {}
    try:
        if pool is not None:
            for i in range(1, len(chunks)):
                bg_futures[i] = pool.submit(_compute_one, chunks[i], i)

        for i, ch in enumerate(chunks):
            if i == 0:
                wav16, ctx_l, hit, ms = _compute_one(ch, 0)
            else:
                wav16, ctx_l, hit, ms = bg_futures[i].result()

            # Upsample WITH full context so polyphase filter has zero boundary transient
            wav48_full = resample_poly(wav16.astype(np.float64), 3, 1).astype(np.float32)
            base_s0 = ctx_l * HOP_48K
            start_smp = ch.start_frame * HOP_48K
            end_smp = min(sample_count_48k, ch.end_frame * HOP_48K)
            if end_smp <= start_smp:
                continue
            core_len = end_smp - start_smp

            overlap_l = 0
            if i > 0 and not ch.left_is_silence and base_s0 >= STREAM_OVERLAP_SAMPLES_48K:
                overlap_l = min(STREAM_OVERLAP_SAMPLES_48K, start_smp)

            seg = np.ascontiguousarray(
                wav48_full[base_s0 - overlap_l : base_s0 + core_len],
                dtype=np.float32,
            )
            # Apply gentle 2 ms fade-in at utterance start / fade-out at utterance end
            if i == 0 and len(seg) >= 96:
                ramp = np.linspace(0.0, 1.0, 96, dtype=np.float32)
                seg[:96] *= ramp
            if end_smp >= sample_count_48k and len(seg) >= 96:
                ramp = np.linspace(1.0, 0.0, 96, dtype=np.float32)
                seg[-96:] *= ramp

            yield {
                "type": "chunk",
                "index": i,
                "total_chunks": len(chunks),
                "start_sample": start_smp - overlap_l,
                "core_start_sample": start_smp,
                "sample_count": int(len(seg)),
                "overlap_left_samples": int(overlap_l),
                "left_is_silence": ch.left_is_silence,
                "right_is_silence": ch.right_is_silence,
                "cut_reason": ch.cut_reason,
                "cache_hit": hit,
                "model_ms": ms,
                "audio_48k": seg,
            }
    finally:
        if pool is not None:
            pool.shutdown(wait=False, cancel_futures=True)
