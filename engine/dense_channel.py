"""Real VTL 2.4 Dense Control Channel & Geometry Snapshot Service.

Bypasses legacy 201-point curve caps by driving VTL `vtlSynthesisAddTube` directly
at arbitrary frame counts (e.g. 200 Hz / 5 ms steps up to 60 s).
Accepts pressures in Pascals (`Pa`, 0..1600) and converts `dPa = pa * 10` strictly
at the native VTL boundary. Rejects out-of-range inputs without silent clamping.
"""
from __future__ import annotations

import atexit
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import base64
import hashlib
import io
import os
from pathlib import Path
import sys
import threading
import time
from typing import Any, Dict, Iterator, List, Optional, Sequence, Tuple
import wave

import numpy as np

ENGINE_DIR = Path(__file__).resolve().parent
VTL_NATIVE_ROOT = ENGINE_DIR / "vtl_native"
VTL_NATIVE_DIR = VTL_NATIVE_ROOT / "native"

if str(VTL_NATIVE_ROOT) not in sys.path:
    sys.path.insert(0, str(VTL_NATIVE_ROOT))

from phonetic_core.vocal_tract.engine import Engine, PARTS, dp  # noqa: E402
from phonetic_core.vocal_tract.envelope import attack_envelope, audition_samples  # noqa: E402
from phonetic_core.vocal_tract.root_drag import resolve_root_drag  # noqa: E402
from phonetic_core.vocal_tract.trills import live_tube_block, prepare_live_trill  # noqa: E402
from audio_transitions import finish_synthesis  # noqa: E402
from trills import apply_trill, apply_trill_to_tract19, resolve_trill_place  # noqa: E402
from validation import (  # noqa: E402
    SAMPLE_RATE_HZ,
    is_finite_number,
    out_of_range_error,
    validate_glottis_frames,
    validate_scalar_range,
    validate_scalar_series,
    validate_shape_frames,
    validate_tract19_frames,
    validation_error,
)

F0_MIN_HZ = 40.0
VOQS_NATIVE_F0_MIN_HZ = 40.0
F0_MAX_HZ = 600.0
PRESSURE_MIN_PA = 0.0
PRESSURE_MAX_PA = 1600.0
DEFAULT_SECTIONS = 65
_SPEAKERS = ("JD2", "W02", "M01", "JD2-2D", "W02-2D")
DEFAULT_ENGINE_LOCK_TIMEOUT_S = max(
    0.05,
    float(os.environ.get("VOCALCUT_ENGINE_LOCK_TIMEOUT_S", "30.0") or "30.0"),
)


class EngineBusyError(RuntimeError):
    """Raised when a per-speaker VTL engine lock cannot be acquired within timeout."""

    def __init__(self, speaker: str, timeout_s: float) -> None:
        self.speaker = speaker
        self.timeout_s = timeout_s
        hint = f"说话人 {speaker} 的声道引擎正忙（等待超过 {timeout_s:g} 秒），请稍后重试"
        self.result: Dict[str, Any] = {
            "ok": False,
            "error": {
                "code": "engine_busy",
                "field": "speaker",
                "value": speaker,
                "hint": hint,
            },
            "hint": hint,
        }
        super().__init__(hint)


PLAYBACK_TARGET_PEAK = 0.8
MIN_NORMALIZE_PEAK = 1e-5
# Peak scaling on hybrid multi-core CPUs hits physical performance cores (8 workers on 24-core CPUs = ~6.8-10x speedup).
VTL_PARALLEL_WORKERS = min(8, max(1, (os.cpu_count() or 4) // 2))
VTL_WARMUP_SEC = 0.160          # 160 ms tube/glottis warm-up pre-roll for non-silence cuts
VTL_VALLEY_XFADE_SEC = 0.010    # 10 ms cosine crossfade centered at low-pressure breath valley
VTL_VOICED_XFADE_SEC = 0.015    # 15 ms pitch-aligned cosine crossfade for high-pressure voiced cuts
VTL_ALIGN_MAX_LAG_SEC = 0.006   # +/- 6 ms pitch-period lag search (covers F0 >= 83 Hz)
VTL_DEAD_SILENCE_MIN_SEC = 0.25 # Only skip contiguous PR==0 runs >= 250 ms (keep short leading/interior silences intact)
VTL_RINGOUT_TAIL_SEC = 0.050    # Keep 50 ms post-speech tail after PR>0 so 26 Hz HPF state matches bit-identically


class _BoundedObjLRU:
    """Thread-safe bounded LRU cache for VTL prepared tubes and per-phrase 48 kHz PCM."""

    def __init__(self, max_entries: int, max_bytes: int = 0) -> None:
        self._lock = threading.Lock()
        self._max_entries = max_entries
        self._max_bytes = max_bytes
        self._store: OrderedDict[Any, Tuple[Any, int]] = OrderedDict()
        self._total_bytes = 0
        self._hits = 0
        self._misses = 0

    def get(self, key: Any) -> Any:
        with self._lock:
            item = self._store.get(key)
            if item is None:
                self._misses += 1
                return None
            self._store.move_to_end(key)
            self._hits += 1
            return item[0]

    def put(self, key: Any, value: Any, nbytes: int = 0) -> None:
        if self._max_bytes > 0 and nbytes > self._max_bytes:
            return
        with self._lock:
            prev = self._store.pop(key, None)
            if prev is not None:
                self._total_bytes -= prev[1]
            self._store[key] = (value, nbytes)
            self._total_bytes += nbytes
            while len(self._store) > self._max_entries or (
                self._max_bytes > 0 and self._total_bytes > self._max_bytes
            ):
                _, (_, ev_bytes) = self._store.popitem(last=False)
                self._total_bytes -= ev_bytes

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


_VTL_TUBE_CACHE = _BoundedObjLRU(max_entries=24000)
_VTL_PHRASE_CACHE = _BoundedObjLRU(max_entries=256, max_bytes=160 * 1024 * 1024)
_VTL_POSE_SNAPSHOT_CACHE = _BoundedObjLRU(max_entries=512)


def clear_vtl_caches() -> None:
    _VTL_TUBE_CACHE.clear()
    _VTL_PHRASE_CACHE.clear()
    _VTL_POSE_SNAPSHOT_CACHE.clear()


def get_vtl_cache_stats() -> Dict[str, Dict[str, int]]:
    return {
        "tubes": _VTL_TUBE_CACHE.stats(),
        "phrases": _VTL_PHRASE_CACHE.stats(),
        "pose_snapshots": _VTL_POSE_SNAPSHOT_CACHE.stats(),
    }


def plan_vtl_silence_phrases(pr_pa: np.ndarray, step_hz: int) -> List[Tuple[int, int]]:
    """Split a VTL control track ONLY at true silence gaps (>= 50 ms of PR <= 0.5 Pa) so tube ring-out decays to zero."""
    n = int(len(pr_pa))
    if n <= 0:
        return []
    min_sil_frames = max(3, int(round(0.050 * step_hz)))
    ringout_frames = max(2, int(round(0.035 * step_hz)))
    min_phrase_frames = max(4, int(round(0.250 * step_hz)))
    if n < min_phrase_frames * 2 + min_sil_frames:
        return [(0, n)]

    silent = pr_pa <= 0.5
    if not np.any(silent):
        return [(0, n)]
    padded = np.concatenate(([False], silent, [False]))
    diff = np.diff(padded.astype(np.int8))
    starts = np.flatnonzero(diff == 1)
    ends = np.flatnonzero(diff == -1)

    cuts: List[int] = [0]
    for a_raw, b_raw in zip(starts, ends):
        a, b = int(a_raw), int(b_raw)
        if (b - a) < min_sil_frames:
            continue
        # Only split interior silence runs with real speech on both sides
        if a <= cuts[-1] + min_phrase_frames or b >= n - min_phrase_frames:
            continue
        cut = min(b - 1, a + max(ringout_frames, (b - a) // 2))
        if cut - cuts[-1] >= min_phrase_frames and n - cut >= min_phrase_frames:
            if bool(np.any(pr_pa[cuts[-1] : cut] > 5.0)) and bool(np.any(pr_pa[cut:n] > 5.0)):
                cuts.append(cut)
    cuts.append(n)
    return [(cuts[i], cuts[i + 1]) for i in range(len(cuts) - 1)]


def plan_vtl_chunks(
    pr_pa: np.ndarray,
    step_hz: int,
    *,
    articulation_spans: Optional[Sequence[Dict[str, Any]]] = None,
    target_chunk_s: float = 5.8,
    min_chunk_s: float = 2.4,
    first_chunk_max_s: Optional[float] = None,
) -> Tuple[List[Tuple[int, int, str, str]], int]:
    """Plan lossless parallel VTL chunks across both paused and continuous singing/speech tracks.

    Returns `(chunks, skipped_dead_silence_frames)` where each chunk tuple is:
      `(start_frame, end_frame, left_boundary_kind, right_boundary_kind)`
    Boundary kinds:
      - `'silence'`: true silence (`PR <= 0.5 Pa` for `>= 50 ms`) or track start/end -> 0 warm-up, 0 crossfade (bit-exact)
      - `'valley'`: natural phrase/breath dip (`PR <= 60 Pa`) -> 160 ms warm-up + 10 ms valley crossfade (0 drift)
      - `'closure'`: stop consonant closure span -> 160 ms warm-up + 10 ms crossfade (0 drift)
      - `'voiced'`: fallback continuous voiced cut -> 160 ms warm-up + 15 ms pitch-aligned crossfade
    """
    n = int(len(pr_pa))
    if n <= 0:
        return [], 0

    # 1. Identify active islands, skipping only long dead-silence (PR <= 0) runs >= 250 ms
    #    after keeping a 50 ms post-speech tail so finish_synthesis HPF state matches bit-identically.
    if not bool(np.any(pr_pa > 0.0)):
        return [], n

    ring_fr = max(2, int(round(VTL_RINGOUT_TAIL_SEC * step_hz)))
    dead_min_fr = max(ring_fr + 2, int(round(VTL_DEAD_SILENCE_MIN_SEC * step_hz)))
    pos_mask = pr_pa > 0.0
    active = pos_mask.copy()
    for d in range(1, ring_fr + 1):
        if d < n:
            active[d:] |= pos_mask[:-d]

    # Bridge any interior zero-gaps shorter than dead_min_fr (and leading silence < dead_min_fr)
    # so short clips keep exact frame-0 parity with serial synthesis.
    inv = ~active
    if bool(np.any(inv)):
        p_inv = np.concatenate(([False], inv, [False]))
        d_inv = np.diff(p_inv.astype(np.int8))
        for za, zb in zip(np.flatnonzero(d_inv == 1), np.flatnonzero(d_inv == -1)):
            if int(zb - za) < dead_min_fr:
                active[int(za) : int(zb)] = True

    skipped_frames = int((~active).sum())
    p_act = np.concatenate(([False], active, [False]))
    d_act = np.diff(p_act.astype(np.int8))
    islands = [(int(a), int(b)) for a, b in zip(np.flatnonzero(d_act == 1), np.flatnonzero(d_act == -1))]

    # Collect interior stop closures from articulation_spans if provided
    closure_mids: List[int] = []
    if articulation_spans:
        for sp in articulation_spans:
            if isinstance(sp, dict) and sp.get("phase") == "closure":
                a_f, b_f = sp.get("start_frame"), sp.get("end_frame")
                if type(a_f) is int and type(b_f) is int and 0 <= a_f < b_f <= n:
                    closure_mids.append((a_f + b_f) // 2)

    min_sil_fr = max(3, int(round(0.050 * step_hz)))
    ringout_sil_fr = max(2, int(round(0.035 * step_hz)))
    min_phrase_fr = max(4, int(round(0.250 * step_hz)))
    target_fr = max(min_phrase_fr * 2, int(round(target_chunk_s * step_hz)))
    min_fr = max(min_phrase_fr, int(round(min_chunk_s * step_hz)))
    first_limit_fr = (
        max(min_phrase_fr * 2, int(round(first_chunk_max_s * step_hz)))
        if first_chunk_max_s is not None
        else None
    )

    chunks: List[Tuple[int, int, str, str]] = []

    for ia, ib in islands:
        # First split each active island at any interior true silence runs (>= 50 ms of PR <= 0.5 Pa)
        sub_pr = pr_pa[ia:ib]
        sub_phrases = plan_vtl_silence_phrases(sub_pr, step_hz)
        for sa_rel, sb_rel in sub_phrases:
            sa, sb = ia + sa_rel, ia + sb_rel
            seg_len = sb - sa
            is_first_overall = len(chunks) == 0
            eff_target = min(target_fr, first_limit_fr) if (is_first_overall and first_limit_fr) else target_fr
            if seg_len <= eff_target + min_fr // 2:
                chunks.append((sa, sb, "silence", "silence"))
                continue

            # Long continuous voiced/singing section without >= 50ms silence:
            # split cleanly at breath valleys (PR <= 60 Pa), stop closures, or lowest-PR troughs.
            pos = sa
            left_kind = "silence"
            while pos < sb:
                rem = sb - pos
                cur_is_first = len(chunks) == 0
                cur_target = min(target_fr, first_limit_fr) if (cur_is_first and first_limit_fr) else target_fr
                cur_min = min(min_fr, max(min_phrase_fr, cur_target // 2))
                if rem <= cur_target + cur_min // 2:
                    chunks.append((pos, sb, left_kind, "silence"))
                    break

                lo = pos + cur_min
                hi = min(sb - cur_min, pos + cur_target + int(round(1.5 * step_hz)))
                if hi <= lo:
                    chunks.append((pos, sb, left_kind, "silence"))
                    break

                pref = pos + cur_target
                win_pr = pr_pa[lo:hi]
                min_pr_val = float(np.min(win_pr))
                cut: Optional[int] = None
                cut_kind = "voiced"

                # Priority 1: interior PR <= 60 Pa breath/phrase valley (matches singing line boundaries cleanly)
                if min_pr_val <= 60.0:
                    thresh = max(min_pr_val + 8.0, 50.0)
                    cand_mask = win_pr <= thresh
                    p2 = np.concatenate(([False], cand_mask, [False]))
                    d2 = np.diff(p2.astype(np.int8))
                    runs = [(lo + int(r_a), lo + int(r_b)) for r_a, r_b in zip(np.flatnonzero(d2 == 1), np.flatnonzero(d2 == -1))]
                    if runs:
                        def _valley_score(r: Tuple[int, int]) -> Tuple[int, float, float]:
                            r_pr = pr_pa[r[0] : r[1]]
                            r_min = float(np.min(r_pr))
                            r_mid = (r[0] + r[1]) // 2
                            is_deep = 0 if r_min <= 1.0 else (1 if r_min <= 35.0 else 2)
                            return (is_deep, abs(r_mid - pref) / float(step_hz), r_min)
                        best_r = min(runs, key=_valley_score)
                        r_sub = pr_pa[best_r[0] : best_r[1]]
                        if float(np.max(r_sub)) <= 0.5 and (best_r[1] - best_r[0]) >= min_sil_fr:
                            cut = min(best_r[1] - 1, best_r[0] + max(ringout_sil_fr, (best_r[1] - best_r[0]) // 2))
                            cut_kind = "silence"
                        else:
                            # Pick the exact minimum-PR frame inside the breath valley so crossfade sits in the quietest trough
                            cut = best_r[0] + int(np.argmin(r_sub))
                            cut_kind = "valley"

                # Priority 2: stop consonant closure midpoint in [lo, hi]
                if cut is None and closure_mids:
                    cl_cands = [c for c in closure_mids if lo <= c < hi]
                    if cl_cands:
                        cut = min(cl_cands, key=lambda c: (float(pr_pa[c]) * 0.01 + abs(c - pref) / float(step_hz)))
                        cut_kind = "closure"

                # Priority 3: lowest pressure frame in [lo, hi]
                if cut is None:
                    cut = lo + int(np.argmin(win_pr))
                    cut_kind = "voiced"

                chunks.append((pos, cut, left_kind, cut_kind))
                pos = cut
                left_kind = cut_kind

    return chunks, skipped_frames


def _find_pitch_aligned_lag(
    prev_tail: np.ndarray,
    cur_pcm: np.ndarray,
    core_off: int,
    core_len: int,
    xfade_smp: int,
    max_lag: int,
) -> int:
    """Find best pitch-period lag within +/-max_lag samples for click-free voiced crossfade."""
    pa = prev_tail - float(np.mean(prev_tail))
    pan = float(np.linalg.norm(pa))
    if pan <= 1e-6:
        return 0
    lo_l = max(-max_lag, -core_off)
    hi_l = min(max_lag, len(cur_pcm) - (core_off + core_len))
    if hi_l < lo_l:
        return 0
    best_lag = 0
    best_corr = -1e18
    for lag in range(lo_l, hi_l + 1):
        seg = cur_pcm[core_off + lag : core_off + lag + xfade_smp]
        if len(seg) != xfade_smp:
            continue
        pb = seg - float(np.mean(seg))
        pbn = float(np.linalg.norm(pb))
        if pbn > 1e-6:
            c = float(np.dot(pa, pb)) / (pan * pbn)
            if c > best_corr:
                best_corr = c
                best_lag = lag
    return best_lag


def _freeze_tube_dict(tube: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for k, v in tube.items():
        if isinstance(v, np.ndarray):
            arr = np.ascontiguousarray(v, dtype=v.dtype).copy()
            arr.setflags(write=False)
            out[k] = arr
        else:
            out[k] = v
    return out


def _make_pose_cache_key(
    speaker: str,
    section_count: Optional[int],
    manual_root: bool,
    tract19: np.ndarray,
    lip_width: float,
    larynx_height: float,
    tongue_shape: Optional[Sequence[float]],
    lip_shape: Optional[Sequence[float]],
) -> Tuple[Any, ...]:
    ts = None if tongue_shape is None else tuple(round(float(v), 6) for v in tongue_shape)
    ls = None if lip_shape is None else tuple(round(float(v), 6) for v in lip_shape)
    return (
        speaker,
        section_count,
        bool(manual_root),
        tuple(round(float(x), 6) for x in tract19),
        round(float(lip_width), 5),
        round(float(larynx_height), 5),
        ts,
        ls,
    )


def pcm_float_to_wav_bytes(audio_f64: np.ndarray, sr: int = SAMPLE_RATE_HZ) -> bytes:
    arr = np.asarray(audio_f64, dtype=np.float64)
    if arr.size == 0:
        arr = np.zeros(1, dtype=np.float64)
    peak = float(np.max(np.abs(arr)))
    if peak > 0.99:
        arr = arr * (0.95 / peak)
    pcm16 = np.clip(np.round(arr * 32767.0), -32768, 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(int(sr))
        wf.writeframes(pcm16.tobytes())
    return buf.getvalue()


def _soft_limit_audio(arr: np.ndarray, knee: float = 0.85, ceiling: float = 0.96) -> np.ndarray:
    abs_x = np.abs(arr)
    over = abs_x > knee
    if not np.any(over):
        return arr
    out = arr.copy()
    head = ceiling - knee
    out[over] = np.sign(arr[over]) * (knee + head * np.tanh((abs_x[over] - knee) / head))
    return out


def normalize_for_playback(
    audio_f64: np.ndarray,
    target_peak: float = PLAYBACK_TARGET_PEAK,
) -> np.ndarray:
    """Scale the entire clip by one uniform factor so its strongest peak reaches target_peak."""
    arr = np.asarray(audio_f64, dtype=np.float64)
    if arr.size == 0:
        return arr
    peak = float(np.max(np.abs(arr)))
    if not np.isfinite(peak) or peak < MIN_NORMALIZE_PEAK:
        return arr
    return arr * (float(target_peak) / peak)


def apply_synthesis_gain(audio: np.ndarray, mode: str | None) -> np.ndarray:
    """Apply one uniform peak-scaling gain to the complete signal unless mode is 'original'."""
    if mode == "original" or not audio.size:
        return audio
    return normalize_for_playback(audio, target_peak=PLAYBACK_TARGET_PEAK)


def resolve_dense_step_hz(payload: Dict[str, Any]) -> Tuple[Optional[int], Optional[Dict[str, Any]]]:
    """Resolve and strictly validate `step_hz` / `frame_step_ms` (default 200 Hz)."""
    raw_step = payload.get("step_hz")
    if raw_step is None and "frame_step_ms" in payload and payload["frame_step_ms"] is not None:
        raw_ms = payload["frame_step_ms"]
        if not is_finite_number(raw_ms) or float(raw_ms) <= 0:
            return None, out_of_range_error("frame_step_ms", raw_ms, 1, 40, "ms")
        step_hz = round(1000.0 / float(raw_ms))
    else:
        step_hz = 200 if raw_step is None else raw_step
    if type(step_hz) is not int or step_hz <= 0 or SAMPLE_RATE_HZ % step_hz != 0 or not 25 <= step_hz <= 1000:
        return None, out_of_range_error("step_hz", step_hz, 25, 1000, "Hz", "step_hz 须为整除 48000 Hz 的整数（如 200 Hz）")
    return step_hz, None


def resample_tract_frames_to_50hz(tract_arr: np.ndarray, step_hz: int, sample_count: int) -> List[List[float]]:
    """Sample `(N, 19)` tract trajectory onto exact 50 Hz (20 ms = 960 samples @ 48 kHz) frame centers.

    Preserves exact frame count (`round(duration_s * 50)`, minimum 1) and exact transition
    timestamps across any valid `step_hz` (e.g. 25, 50, 100, 125, 200, 250, 500, 1000 Hz).
    """
    n_in = int(len(tract_arr))
    if n_in <= 0:
        return []
    step_samples = SAMPLE_RATE_HZ // step_hz
    target_step_samples = SAMPLE_RATE_HZ // 50  # 960 samples = 20 ms
    n_out = max(1, (int(sample_count) + target_step_samples // 2) // target_step_samples)
    if step_hz == 50 and n_out == n_in:
        return np.asarray(tract_arr, dtype=np.float64).tolist()
    centers_smp = np.minimum(
        float(max(0, sample_count - 1)),
        (np.arange(n_out, dtype=np.float64) + 0.5) * float(target_step_samples),
    )
    src_pos = np.clip(centers_smp / float(step_samples) - 0.5, 0.0, float(n_in - 1))
    lo = np.floor(src_pos).astype(np.int64)
    hi = np.minimum(n_in - 1, lo + 1)
    frac = (src_pos - lo)[:, None]
    arr64 = np.asarray(tract_arr, dtype=np.float64)
    out = arr64[lo] * (1.0 - frac) + arr64[hi] * frac
    return np.round(out, 6).tolist()


class DenseEngineManager:
    """Thread-safe per-speaker VTL 2.4 Engine singleton pool with scoped geometry leases."""

    def __init__(
        self,
        resource_dir: Path = VTL_NATIVE_DIR,
        *,
        lock_timeout_s: Optional[float] = None,
    ) -> None:
        self.resource_dir = Path(resource_dir)
        self.lock_timeout_s = float(DEFAULT_ENGINE_LOCK_TIMEOUT_S if lock_timeout_s is None else lock_timeout_s)
        self._engines: Dict[str, Engine] = {}
        self._locks: Dict[str, threading.RLock] = {}
        self._worker_pools: Dict[str, List[Tuple[Engine, threading.RLock]]] = {}
        self._live_sessions: Dict[str, Dict[str, Any]] = {}
        self._resonance_caches: Dict[str, OrderedDict[Tuple[str, int, bool, Tuple[float, ...]], Tuple[float, float, float]]] = {}
        self._pool_lock = threading.Lock()
        atexit.register(self.close_all)

    @contextmanager
    def _acquire_lock(
        self,
        lock: threading.RLock,
        speaker: str,
        timeout: Optional[float] = None,
    ) -> Iterator[None]:
        eff_timeout = self.lock_timeout_s if timeout is None else float(timeout)
        acquired = lock.acquire(timeout=eff_timeout)
        if not acquired:
            raise EngineBusyError(speaker, eff_timeout)
        try:
            yield
        finally:
            lock.release()

    def get_engine(self, speaker: str = "JD2") -> Tuple[Engine, threading.RLock]:
        if speaker not in _SPEAKERS:
            raise ValueError(f"Unsupported speaker: {speaker}")
        with self._pool_lock:
            if speaker not in self._engines:
                eng = Engine(speaker, resource_dir=self.resource_dir)
                if not speaker.endswith("-2D"):
                    eng.set_section_count(DEFAULT_SECTIONS)
                self._engines[speaker] = eng
                self._locks[speaker] = threading.RLock()
                self._resonance_caches[speaker] = OrderedDict()
            return self._engines[speaker], self._locks[speaker]

    @contextmanager
    def lease(
        self,
        speaker: str = "JD2",
        *,
        manual_root: bool = False,
        section_count: Optional[int] = None,
        timeout: Optional[float] = None,
    ) -> Iterator[Engine]:
        """Acquire speaker engine lock with timeout and guaranteed state reset on exit."""
        eng, lock = self.get_engine(speaker)
        with self._acquire_lock(lock, speaker, timeout=timeout):
            is_3d = not speaker.endswith("-2D")
            prev_pert = dict(eng.perturbation) if isinstance(eng.perturbation, dict) else None
            prev_flutter = float(eng.flutter)
            if is_3d:
                target_sc = DEFAULT_SECTIONS if section_count is None else section_count
                if target_sc != eng.section_count:
                    eng.set_section_count(target_sc)
            eng.set_manual_root(bool(manual_root))
            try:
                yield eng
            finally:
                try:
                    eng.set_manual_root(False)
                    if is_3d and eng.section_count != DEFAULT_SECTIONS:
                        eng.set_section_count(DEFAULT_SECTIONS)
                    eng.configure_perturbation(prev_pert, restart=True)
                    eng.flutter = prev_flutter
                except Exception:
                    pass

    def _get_worker_pool(self, speaker: str, count: int) -> List[Tuple[Engine, threading.RLock]]:
        """Lazily allocate up to `count` isolated native VTL Engine instances (each owns private DLL handles)."""
        n = max(1, min(VTL_PARALLEL_WORKERS, int(count)))
        primary = self.get_engine(speaker)
        if n == 1:
            return [primary]
        with self._pool_lock:
            extras = self._worker_pools.setdefault(speaker, [])
            while 1 + len(extras) < n:
                eng = Engine(speaker, resource_dir=self.resource_dir)
                if not speaker.endswith("-2D"):
                    eng.set_section_count(DEFAULT_SECTIONS)
                extras.append((eng, threading.RLock()))
            return [primary, *extras[: n - 1]]

    def prepare_tubes_batch(
        self,
        speaker: str,
        pose_specs: Sequence[Tuple[Tuple[Any, ...], np.ndarray, float, float, Optional[Sequence[float]], Optional[Sequence[float]], bool]],
        *,
        section_count: Optional[int] = None,
        skip_primary: bool = False,
    ) -> Tuple[Dict[Tuple[Any, ...], Dict[str, Any]], int, int, int]:
        """Resolve a batch of unique 3D tube geometries using `_VTL_TUBE_CACHE` + GIL-free parallel C++ workers.

        Returns `(tubes_by_key, cache_hits, computed_count, workers_used)`. Output is bit-identical to serial `prepare_tube`.
        """
        tubes: Dict[Tuple[Any, ...], Dict[str, Any]] = {}
        misses: List[Tuple[Tuple[Any, ...], np.ndarray, float, float, Optional[Sequence[float]], Optional[Sequence[float]], bool]] = []
        cache_hits = 0
        seen: set[Tuple[Any, ...]] = set()
        for spec in pose_specs:
            key = spec[0]
            if key in seen:
                continue
            seen.add(key)
            cached = _VTL_TUBE_CACHE.get(key)
            if cached is not None:
                tubes[key] = cached
                cache_hits += 1
            else:
                misses.append(spec)

        if not misses:
            return tubes, cache_hits, 0, 1

        is_3d = not speaker.endswith("-2D")
        target_sc = DEFAULT_SECTIONS if (is_3d and section_count is None) else section_count
        desired_workers = min(VTL_PARALLEL_WORKERS, max(1, len(misses) // 8)) if len(misses) >= 12 else 1
        if skip_primary and VTL_PARALLEL_WORKERS > 1:
            pool_all = self._get_worker_pool(speaker, min(VTL_PARALLEL_WORKERS, max(2, desired_workers + 1)))
            workers = pool_all[1:] if len(pool_all) > 1 else pool_all
        else:
            workers = self._get_worker_pool(speaker, desired_workers)

        def _compute_partition(
            worker: Tuple[Engine, threading.RLock],
            part: Sequence[Tuple[Tuple[Any, ...], np.ndarray, float, float, Optional[Sequence[float]], Optional[Sequence[float]], bool]],
        ) -> List[Tuple[Tuple[Any, ...], Dict[str, Any]]]:
            eng, lock = worker
            out_pairs: List[Tuple[Tuple[Any, ...], Dict[str, Any]]] = []
            with self._acquire_lock(lock, speaker):
                if is_3d and target_sc is not None and eng.section_count != target_sc:
                    eng.set_section_count(target_sc)
                prev_mr: Optional[bool] = None
                try:
                    for key, tract19, lw, lh, ts, ls, mr in part:
                        if mr != prev_mr:
                            eng.set_manual_root(bool(mr))
                            prev_mr = bool(mr)
                        p_vec = eng.validated(tract19)
                        raw_tube = eng.prepare_tube(p_vec, lw, lh, ts, ls)
                        frozen = _freeze_tube_dict(raw_tube)
                        _VTL_TUBE_CACHE.put(key, frozen)
                        out_pairs.append((key, frozen))
                finally:
                    try:
                        eng.set_manual_root(False)
                        if is_3d and eng.section_count != DEFAULT_SECTIONS:
                            eng.set_section_count(DEFAULT_SECTIONS)
                    except Exception:
                        pass
            return out_pairs

        if len(workers) == 1:
            for k, val in _compute_partition(workers[0], misses):
                tubes[k] = val
        else:
            buckets: List[List[Any]] = [[] for _ in workers]
            for idx_m, spec in enumerate(misses):
                buckets[idx_m % len(workers)].append(spec)
            # Run bucket 0 on calling thread (re-entrant safe if caller already holds primary RLock)
            # while running isolated worker engines 1..N-1 concurrently in GIL-free C++.
            with ThreadPoolExecutor(max_workers=len(workers) - 1) as pool:
                futs = [
                    pool.submit(_compute_partition, workers[wi], buckets[wi])
                    for wi in range(1, len(workers))
                    if buckets[wi]
                ]
                if buckets[0]:
                    for k, val in _compute_partition(workers[0], buckets[0]):
                        tubes[k] = val
                for fut in futs:
                    for k, val in fut.result():
                        tubes[k] = val

        return tubes, cache_hits, len(misses), len(workers)

    def close_all(self) -> None:
        with self._pool_lock:
            engines = list(self._engines.items())
            worker_engines = [eng for pool in self._worker_pools.values() for eng, _ in pool]
            live_engines = [sess["eng"] for sess in self._live_sessions.values() if "eng" in sess]
            self._engines.clear()
            self._locks.clear()
            self._worker_pools.clear()
            self._live_sessions.clear()
            self._resonance_caches.clear()
        for _, eng in engines:
            try:
                eng.close()
            except Exception:
                pass
        for eng in [*worker_engines, *live_engines]:
            try:
                eng.close()
            except Exception:
                pass

    def _get_live_session(self, speaker: str = "JD2") -> Dict[str, Any]:
        if speaker not in _SPEAKERS:
            raise ValueError(f"Unsupported speaker: {speaker}")
        with self._pool_lock:
            sess = self._live_sessions.get(speaker)
            if sess is None:
                eng = Engine(speaker, resource_dir=self.resource_dir)
                if not speaker.endswith("-2D"):
                    eng.set_section_count(DEFAULT_SECTIONS)
                sess = {
                    "eng": eng,
                    "lock": threading.RLock(),
                    "current_tube": None,
                    "offset": 0,
                    "pitch_gain": 1.0,
                    "peak_ema": 0.0,
                    "manual_root": False,
                    "shimmer": 0.0,
                    "flutter": float(eng.default_flutter),
                    "trill_key": None,
                    "trill_cycle": None,
                }
                self._live_sessions[speaker] = sess
            return sess

    def live_pull(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Pull continuous 48 kHz 960-sample VTL 2.4 tube blocks on an isolated live Engine."""
        speaker = str(payload.get("speaker", "JD2"))
        try:
            sess = self._get_live_session(speaker)
        except ValueError as exc:
            return validation_error("speaker", str(exc))

        eng: Engine = sess["eng"]
        reset_req = payload.get("reset", False)
        if type(reset_req) is not bool:
            return validation_error("reset", "reset 必须为布尔值")

        blocks_raw = payload.get("blocks", 3)
        if type(blocks_raw) is not int or not 1 <= blocks_raw <= 12:
            return out_of_range_error("blocks", blocks_raw, 1, 12, "blocks")

        params = payload.get("params")
        if not isinstance(params, list) or len(params) != 19:
            return validation_error("params", "params 必须为 19 维声道参数列表")
        tract_arr, err = validate_tract19_frames([params], eng.names, eng.minimum, eng.maximum, field="params")
        if err:
            return err
        assert tract_arr is not None

        f0_raw = payload.get("f0_hz", 160.0)
        err = validate_scalar_range("f0_hz", f0_raw, float(eng.gmin[0]), float(eng.gmax[0]), "Hz")
        if err:
            if err["error"].get("code") == "out_of_range":
                err["error"]["hint"] = (
                    f"f0_hz ({err['error']['value']} Hz) 超出 VTL 2.4 物理声门原生范围 "
                    f"[{float(eng.gmin[0]):g}, {float(eng.gmax[0]):g}] Hz；请切换 Tract2Vox-Lite 神经合成或调整音高"
                )
            return err
        pr_raw = payload.get("pressure_pa", 800.0)
        err = validate_scalar_range("pressure_pa", pr_raw, PRESSURE_MIN_PA, PRESSURE_MAX_PA, "Pa")
        if err:
            return err

        lw_raw = payload.get("lip_width", 1.0)
        err = validate_scalar_range("lip_width", lw_raw, 0.55, 1.6, "ratio")
        if err:
            return err
        lh_raw = payload.get("larynx_height", 0.0)
        err = validate_scalar_range("larynx_height", lh_raw, -1.0, 1.0, "cm")
        if err:
            return err

        manual_root_req = payload.get("manual_root", False)
        if type(manual_root_req) is not bool:
            return validation_error("manual_root", "manual_root 必须为布尔值")

        ts_raw = payload.get("tongue_shape")
        ls_raw = payload.get("lip_shape")
        err = validate_shape_frames([ts_raw], 1, field="tongue_shape")
        if err:
            return err
        err = validate_shape_frames([ls_raw], 1, field="lip_shape")
        if err:
            return err

        glot_raw = payload.get("glottis")
        glot_vec: Optional[np.ndarray] = None
        if glot_raw is not None:
            glot_mat, err = validate_glottis_frames([glot_raw], 1, field="glottis")
            if err:
                return err
            assert glot_mat is not None
            glot_vec = glot_mat[0]

        f0_val = float(f0_raw)
        pr_val = float(pr_raw)
        lip_width = float(lw_raw)
        larynx_height = float(lh_raw)
        audio_gain = payload.get("audio_gain", "peak")

        def _mutable_tube(src: Dict[str, Any]) -> Dict[str, Any]:
            return {
                "lengths": np.ascontiguousarray(src["lengths"], dtype=np.float64).copy(),
                "areas": np.ascontiguousarray(src["areas"], dtype=np.float64).copy(),
                "articulators": np.ascontiguousarray(src["articulators"], dtype=np.int32).copy(),
                "extras": np.ascontiguousarray(src["extras"], dtype=np.float64).copy(),
            }

        try:
            with self._acquire_lock(sess["lock"], speaker):
                if sess["manual_root"] != manual_root_req:
                    eng.set_manual_root(manual_root_req)
                    sess["manual_root"] = manual_root_req

                flutter_val = float(glot_vec[6]) if glot_vec is not None else float(eng.default_flutter)
                shimmer_val = float(glot_vec[7]) if glot_vec is not None else 0.0
                if abs(shimmer_val - sess["shimmer"]) > 1e-4 or abs(flutter_val - sess["flutter"]) > 1e-4:
                    eng.configure_perturbation(
                        {"jitter": 0.0, "shimmer": shimmer_val, "flutter": flutter_val, "seed": 20261120}
                    )
                    sess["shimmer"] = shimmer_val
                    sess["flutter"] = flutter_val

                g = eng.gneutral.copy()
                g[0] = f0_val
                g[1] = pr_val * 10.0  # Pa -> dPa strictly at native VTL boundary
                g[eng.gnames.index("flutter")] = flutter_val
                if glot_vec is not None:
                    g[eng.gnames.index("x_bottom")] = float(glot_vec[0])
                    g[eng.gnames.index("x_top")] = float(glot_vec[1])
                    g[eng.gnames.index("chink_area")] = float(glot_vec[2])
                    g[eng.gnames.index("lag")] = float(glot_vec[3])
                    g[eng.gnames.index("rel_amp")] = float(glot_vec[4])
                    g[eng.gnames.index("pulse_shape")] = float(glot_vec[5])
                    # Unvoiced frames (rel_amp <= 0) have no periodic glottal oscillation;
                    # 125 Hz is a neutral internal VTL placeholder documented in MODEL_INTERFACE_SPEC.md.
                    if float(glot_vec[4]) <= 0.0:
                        g[0] = 125.0
                g = np.ascontiguousarray(np.clip(g, eng.gmin, eng.gmax), dtype=np.float64)

                pose_key = _make_pose_cache_key(
                    speaker,
                    eng.section_count if not speaker.endswith("-2D") else None,
                    manual_root_req,
                    tract_arr[0],
                    lip_width,
                    larynx_height,
                    ts_raw,
                    ls_raw,
                )
                cached_tube = _VTL_TUBE_CACHE.get(pose_key)
                if cached_tube is None:
                    p_valid = eng.validated(tract_arr[0])
                    raw_t = eng.prepare_tube(p_valid, lip_width, larynx_height, ts_raw, ls_raw)
                    cached_tube = _freeze_tube_dict(raw_t)
                    _VTL_TUBE_CACHE.put(pose_key, cached_tube)

                target_tube = cached_tube
                trill_place = resolve_trill_place(payload.get("trill")) if speaker in ("JD2", "JD2-2D") else None
                if trill_place is not None:
                    t_key = (trill_place, pose_key)
                    if sess["trill_key"] != t_key:
                        pose_obj = {
                            "params": tract_arr[0].tolist(),
                            "lip_width": lip_width,
                            "larynx_height": larynx_height,
                            "tongue_shape": ts_raw,
                            "lip_shape": ls_raw,
                        }
                        sess["trill_cycle"] = prepare_live_trill(eng, pose_obj, trill_place)
                        sess["trill_key"] = t_key
                else:
                    sess["trill_key"] = None
                    sess["trill_cycle"] = None

                target_pg = eng.pitch_level_gain(target_tube, f0_val)
                if reset_req or sess["current_tube"] is None:
                    sess["current_tube"] = _mutable_tube(target_tube)
                    eng.reset_tube(sess["current_tube"], g)
                    sess["offset"] = 0
                    sess["pitch_gain"] = target_pg
                    sess["peak_ema"] = 0.0

                n_block = 960
                parts: List[np.ndarray] = []
                for _ in range(blocks_raw):
                    cur_tube = sess["current_tube"]
                    if sess["trill_cycle"] is None:
                        interp_tube = {
                            "lengths": np.ascontiguousarray(cur_tube["lengths"] + 0.4 * (target_tube["lengths"] - cur_tube["lengths"]), dtype=np.float64),
                            "areas": np.ascontiguousarray(cur_tube["areas"] + 0.4 * (target_tube["areas"] - cur_tube["areas"]), dtype=np.float64),
                            "articulators": np.ascontiguousarray(target_tube["articulators"], dtype=np.int32),
                            "extras": np.ascontiguousarray(cur_tube["extras"] + 0.4 * (target_tube["extras"] - cur_tube["extras"]), dtype=np.float64),
                        }
                        sess["current_tube"] = interp_tube
                        raw_blk = eng.block_tube(interp_tube, g, n_block)
                    else:
                        next_t, raw_blk = live_tube_block(
                            eng, cur_tube, target_tube, g, n_block, sess["offset"], sess["trill_cycle"]
                        )
                        sess["current_tube"] = _mutable_tube(next_t)

                    raw_blk = raw_blk * np.linspace(sess["pitch_gain"], target_pg, n_block)
                    sess["pitch_gain"] = target_pg
                    env = attack_envelope(sess["offset"], n_block, eng.sr)
                    blk = audition_samples(raw_blk, 0.82, 0.0, env)
                    if pr_val <= 0.0:
                        blk = np.zeros(n_block, dtype=np.float64)
                    elif audio_gain == "peak":
                        blk_peak = float(np.max(np.abs(blk)))
                        sess["peak_ema"] = max(blk_peak, sess["peak_ema"] * 0.992) if sess["peak_ema"] > 0 else blk_peak
                        if sess["peak_ema"] > 1e-4:
                            scale = min(2.2, PLAYBACK_TARGET_PEAK / max(0.12, sess["peak_ema"]))
                            blk = _soft_limit_audio(blk * scale)
                    parts.append(blk.astype("<f4"))
                    sess["offset"] += n_block

                audio_f32 = np.concatenate(parts) if parts else np.empty(0, dtype="<f4")
                return {
                    "ok": True,
                    "speaker": speaker,
                    "sample_rate_hz": int(eng.sr),
                    "samples": int(len(audio_f32)),
                    "pcm_f32_b64": base64.b64encode(audio_f32.tobytes()).decode("ascii"),
                }
        except EngineBusyError as exc:
            return exc.result

    def status(self) -> Dict[str, Any]:
        with self._pool_lock:
            loaded = list(self._engines.keys())
        return {
            "ready": True,
            "loaded_speakers": loaded,
            "resource_dir": str(self.resource_dir),
            "dll_exists": (self.resource_dir / "VocalTractLabApi.dll").is_file(),
        }

    def metadata(self, speaker: str = "JD2") -> Dict[str, Any]:
        with self.lease(speaker) as eng:
            return eng.metadata()

    def pose_snapshot(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        speaker = str(payload.get("speaker", "JD2"))
        params = payload.get("params")
        if not isinstance(params, list) or len(params) != 19:
            return validation_error("params", "params 必须为 19 维声道参数列表")

        try:
            eng_probe, _ = self.get_engine(speaker)
        except ValueError as exc:
            return validation_error("speaker", str(exc))

        tract_arr, err = validate_tract19_frames([params], eng_probe.names, eng_probe.minimum, eng_probe.maximum, field="params")
        if err:
            return err

        err = validate_scalar_range("lip_width", payload.get("lip_width", 1.0), 0.55, 1.6, "ratio")
        if err:
            return err
        err = validate_scalar_range("larynx_height", payload.get("larynx_height", 0.0), -1.0, 1.0, "cm")
        if err:
            return err
        lip_width = float(payload.get("lip_width", 1.0))
        larynx_height = float(payload.get("larynx_height", 0.0))

        raw_sc = payload.get("section_count")
        target_sc: Optional[int] = None
        if raw_sc is not None and not speaker.endswith("-2D"):
            if type(raw_sc) is not int or raw_sc not in eng_probe.section_options:
                return out_of_range_error("section_count", raw_sc, min(eng_probe.section_options), max(eng_probe.section_options), "sections")
            target_sc = raw_sc

        manual_root_req = payload.get("manual_root", False)
        if type(manual_root_req) is not bool:
            return validation_error("manual_root", "manual_root 必须为布尔值")

        gesture = payload.get("tongue_root_drag")
        use_manual_root = manual_root_req or bool(gesture)
        if gesture and (not isinstance(gesture, dict) or not isinstance(gesture.get("baseline"), list)
                        or not isinstance(gesture.get("target"), list) or speaker.endswith("-2D")):
            return validation_error("tongue_root_drag", "舌根拖动需要立体解剖模型与有效坐标")

        vector = tract_arr[0]
        tongue_shape = payload.get("tongue_shape")
        lip_shape = payload.get("lip_shape")
        cache_key = None
        if not gesture:
            cache_key = _make_pose_cache_key(
                speaker,
                target_sc if not speaker.endswith("-2D") else None,
                use_manual_root,
                vector,
                lip_width,
                larynx_height,
                tongue_shape,
                lip_shape,
            )
            cached_snap = _VTL_POSE_SNAPSHOT_CACHE.get(cache_key)
            if cached_snap is not None:
                return cached_snap
        try:
            with self.lease(speaker, manual_root=use_manual_root, section_count=target_sc) as eng:
                gesture_result = None
                if gesture:
                    try:
                        vector, gesture_result = resolve_root_drag(
                            eng, gesture, lip_width, larynx_height, tongue_shape, lip_shape,
                        )
                    except ValueError as error:
                        return validation_error("tongue_root_drag", str(error))
                try:
                    snap = eng.snapshot(
                        vector,
                        lip_width=lip_width,
                        larynx_height=larynx_height,
                        tongue_shape=tongue_shape,
                        lip_shape=lip_shape,
                    )
                except ValueError as error:
                    return validation_error("pose", str(error))
                if gesture_result:
                    snap["tongue_root_drag"] = gesture_result
                snap["speaker"] = speaker
                snap["ok"] = True
                if cache_key is not None:
                    _VTL_POSE_SNAPSHOT_CACHE.put(cache_key, snap)
                return snap
        except EngineBusyError as exc:
            return exc.result

    def pose_snapshots_batch(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Compute up to 64 full VTL pose snapshots in parallel across isolated C++ workers with LRU caching."""
        speaker = str(payload.get("speaker", "JD2"))
        poses = payload.get("poses")
        if not isinstance(poses, list) or len(poses) == 0:
            return validation_error("poses", "poses 必须为非空 19 维构型数组")
        if len(poses) > 64:
            return out_of_range_error("poses.length", len(poses), 1, 64, "poses", "单次批量声道快照最多支持 64 帧")

        try:
            eng_probe, _ = self.get_engine(speaker)
        except ValueError as exc:
            return validation_error("speaker", str(exc))

        poses_arr, err = validate_tract19_frames(poses, eng_probe.names, eng_probe.minimum, eng_probe.maximum, field="poses")
        if err:
            return err
        assert poses_arr is not None

        err = validate_scalar_range("lip_width", payload.get("lip_width", 1.0), 0.55, 1.6, "ratio")
        if err:
            return err
        err = validate_scalar_range("larynx_height", payload.get("larynx_height", 0.0), -1.0, 1.0, "cm")
        if err:
            return err
        lip_width = float(payload.get("lip_width", 1.0))
        larynx_height = float(payload.get("larynx_height", 0.0))

        raw_sc = payload.get("section_count")
        is_3d = not speaker.endswith("-2D")
        target_sc: Optional[int] = None
        if raw_sc is not None and is_3d:
            if type(raw_sc) is not int or raw_sc not in eng_probe.section_options:
                return out_of_range_error("section_count", raw_sc, min(eng_probe.section_options), max(eng_probe.section_options), "sections")
            target_sc = raw_sc

        manual_root_req = payload.get("manual_root", False)
        if type(manual_root_req) is not bool:
            return validation_error("manual_root", "manual_root 必须为布尔值")

        tongue_shape = payload.get("tongue_shape")
        lip_shape = payload.get("lip_shape")
        err = validate_shape_frames([tongue_shape], 1, field="tongue_shape")
        if err:
            return err
        err = validate_shape_frames([lip_shape], 1, field="lip_shape")
        if err:
            return err

        eff_sc = target_sc if is_3d else None
        keys: List[Tuple[Any, ...]] = []
        snaps_by_key: Dict[Tuple[Any, ...], Dict[str, Any]] = {}
        misses: List[Tuple[Tuple[Any, ...], np.ndarray]] = []
        seen_misses: set[Tuple[Any, ...]] = set()
        cache_hits = 0

        for vec in poses_arr:
            key = _make_pose_cache_key(
                speaker, eff_sc, manual_root_req, vec, lip_width, larynx_height, tongue_shape, lip_shape
            )
            keys.append(key)
            if key in snaps_by_key:
                cache_hits += 1
                continue
            cached = _VTL_POSE_SNAPSHOT_CACHE.get(key)
            if cached is not None:
                snaps_by_key[key] = cached
                cache_hits += 1
            elif key not in seen_misses:
                seen_misses.add(key)
                misses.append((key, vec))

        workers_used = 1
        if misses:
            desired_workers = min(VTL_PARALLEL_WORKERS, max(1, len(misses)))
            workers = self._get_worker_pool(speaker, desired_workers)
            workers_used = len(workers)
            worker_sc = DEFAULT_SECTIONS if (is_3d and target_sc is None) else target_sc

            def _compute_part(
                worker: Tuple[Engine, threading.RLock],
                part: Sequence[Tuple[Tuple[Any, ...], np.ndarray]],
            ) -> List[Tuple[Tuple[Any, ...], Dict[str, Any]]]:
                eng, lock = worker
                out_pairs: List[Tuple[Tuple[Any, ...], Dict[str, Any]]] = []
                with self._acquire_lock(lock, speaker):
                    if is_3d and worker_sc is not None and eng.section_count != worker_sc:
                        eng.set_section_count(worker_sc)
                    eng.set_manual_root(bool(manual_root_req))
                    try:
                        for key, vec in part:
                            snap = eng.snapshot(
                                vec,
                                lip_width=lip_width,
                                larynx_height=larynx_height,
                                tongue_shape=tongue_shape,
                                lip_shape=lip_shape,
                            )
                            snap["speaker"] = speaker
                            snap["ok"] = True
                            _VTL_POSE_SNAPSHOT_CACHE.put(key, snap)
                            out_pairs.append((key, snap))
                    finally:
                        try:
                            eng.set_manual_root(False)
                            if is_3d and eng.section_count != DEFAULT_SECTIONS:
                                eng.set_section_count(DEFAULT_SECTIONS)
                        except Exception:
                            pass
                return out_pairs

            try:
                if len(workers) == 1:
                    for key, snap in _compute_part(workers[0], misses):
                        snaps_by_key[key] = snap
                else:
                    buckets: List[List[Tuple[Tuple[Any, ...], np.ndarray]]] = [[] for _ in workers]
                    for idx_m, item in enumerate(misses):
                        buckets[idx_m % len(workers)].append(item)
                    with ThreadPoolExecutor(max_workers=len(workers) - 1) as pool:
                        futs = [
                            pool.submit(_compute_part, workers[wi], buckets[wi])
                            for wi in range(1, len(workers))
                            if buckets[wi]
                        ]
                        if buckets[0]:
                            for key, snap in _compute_part(workers[0], buckets[0]):
                                snaps_by_key[key] = snap
                        for fut in futs:
                            for key, snap in fut.result():
                                snaps_by_key[key] = snap
            except EngineBusyError as exc:
                return exc.result
            except ValueError as error:
                return validation_error("poses", str(error))

        ordered = [snaps_by_key[k] for k in keys]
        first = ordered[0]
        shared_freq = first.get("frequency")
        shared_mesh_triangles: Dict[str, Any] = {}
        if isinstance(first.get("meshes"), list):
            for mesh in first["meshes"]:
                if isinstance(mesh, dict) and isinstance(mesh.get("name"), str) and isinstance(mesh.get("triangles"), list):
                    shared_mesh_triangles[mesh["name"]] = mesh["triangles"]

        compact_items: List[Dict[str, Any]] = []
        for snap in ordered:
            compact = {k: v for k, v in snap.items() if k not in ("frequency", "meshes", "ok")}
            if snap.get("frequency") != shared_freq:
                compact["frequency"] = snap.get("frequency")
            raw_meshes = snap.get("meshes")
            if isinstance(raw_meshes, list):
                c_meshes = []
                for mesh in raw_meshes:
                    name = mesh.get("name")
                    if name in shared_mesh_triangles and mesh.get("triangles") == shared_mesh_triangles[name]:
                        c_meshes.append({k: v for k, v in mesh.items() if k != "triangles"})
                    else:
                        c_meshes.append(mesh)
                compact["meshes"] = c_meshes
            compact_items.append(compact)

        return {
            "ok": True,
            "speaker": speaker,
            "frequency": shared_freq,
            "mesh_triangles": shared_mesh_triangles,
            "items": compact_items,
            "cache_hits": cache_hits,
            "computed": len(misses),
            "workers": workers_used,
        }

    def synthesize_dense(self, payload: Dict[str, Any], *, voqs_reference: bool = False) -> Dict[str, Any]:
        try:
            return self._synthesize_dense_impl(payload, voqs_reference=voqs_reference)
        except EngineBusyError as exc:
            return exc.result

    def _synthesize_dense_impl(self, payload: Dict[str, Any], *, voqs_reference: bool = False) -> Dict[str, Any]:
        speaker = str(payload.get("speaker", "JD2"))
        f0_hz = payload.get("f0_hz")
        pressure_pa = payload.get("pressure_pa")
        tract_frames = payload.get("tract_frames")
        glottis_frames = payload.get("glottis_frames")

        step_hz, step_err = resolve_dense_step_hz(payload)
        if step_err:
            return step_err
        assert step_hz is not None

        raw_fps = payload.get("fps") if payload.get("fps") is not None else payload.get("anim_fps", 30)
        if type(raw_fps) is not int or not 1 <= raw_fps <= 60:
            return out_of_range_error("fps", raw_fps, 1, 60, "fps")
        fps = raw_fps
        include_geometry = payload.get("include_geometry", True)
        if type(include_geometry) is not bool:
            return validation_error("include_geometry", "include_geometry 必须为布尔值")
        per_frame_shimmer = payload.get("per_frame_shimmer", False)
        if type(per_frame_shimmer) is not bool:
            return validation_error("per_frame_shimmer", "per_frame_shimmer 必须为布尔值")

        if not isinstance(f0_hz, list) or not isinstance(pressure_pa, list) or not isinstance(tract_frames, list):
            return validation_error("dense_channel", "缺少 f0_hz / pressure_pa / tract_frames 数组")
        n_frames = len(f0_hz)
        max_frames = 60 * step_hz
        if not 1 <= n_frames <= max_frames:
            return out_of_range_error("f0_hz.length", n_frames, 1, max_frames, "frames", "单次 VTL 合成最多 60 秒")
        if len(pressure_pa) != n_frames or len(tract_frames) != n_frames:
            return validation_error("lengths", f"数组长度不一致: f0={n_frames}, pressure={len(pressure_pa)}, tract={len(tract_frames)}")

        try:
            eng_probe, _ = self.get_engine(speaker)
        except ValueError as exc:
            return validation_error("speaker", str(exc))

        f0_min_hz = max(F0_MIN_HZ, float(eng_probe.gmin[0]))
        f0_max_hz = min(F0_MAX_HZ, float(eng_probe.gmax[0]))
        f0_arr, err = validate_scalar_series("f0_hz", f0_hz, n_frames, f0_min_hz, f0_max_hz, "Hz")
        if err:
            if err["error"].get("code") == "out_of_range":
                err["error"]["hint"] = (
                    f"{err['error']['field']} ({err['error']['value']} Hz) 超出 VTL 2.4 物理声门原生范围 "
                    f"[{f0_min_hz:g}, {f0_max_hz:g}] Hz；请切换 Tract2Vox-Lite 神经合成或调整音高"
                )
            return err
        pr_arr, err = validate_scalar_series("pressure_pa", pressure_pa, n_frames, PRESSURE_MIN_PA, PRESSURE_MAX_PA, "Pa")
        if err:
            return err
        tract_arr, err = validate_tract19_frames(
            tract_frames, eng_probe.names, eng_probe.minimum, eng_probe.maximum, field="tract_frames", expected_len=n_frames,
        )
        if err:
            return err

        glot_arr: Optional[np.ndarray] = None
        if glottis_frames is not None:
            glot_arr, err = validate_glottis_frames(glottis_frames, n_frames, field="glottis_frames")
            if err:
                return err

        step_samples = SAMPLE_RATE_HZ // step_hz
        sample_count = payload.get("sample_count", n_frames * step_samples)
        if type(sample_count) is not int or not (n_frames - 1) * step_samples < sample_count <= n_frames * step_samples:
            return out_of_range_error("sample_count", sample_count, (n_frames - 1) * step_samples + 1, n_frames * step_samples, "samples")

        lip_widths_raw = payload.get("lip_width_frames") if payload.get("lip_width_frames") is not None else [1.0] * n_frames
        larynx_heights_raw = payload.get("larynx_height_frames") if payload.get("larynx_height_frames") is not None else [0.0] * n_frames
        lip_widths, err = validate_scalar_series("lip_width_frames", lip_widths_raw, n_frames, 0.55, 1.6, "ratio")
        if err:
            return err
        larynx_heights, err = validate_scalar_series("larynx_height_frames", larynx_heights_raw, n_frames, -1.0, 1.0, "cm")
        if err:
            return err

        tongue_shapes = payload.get("tongue_shape_frames") if payload.get("tongue_shape_frames") is not None else [payload.get("tongue_shape")] * n_frames
        lip_shapes = payload.get("lip_shape_frames") if payload.get("lip_shape_frames") is not None else [payload.get("lip_shape")] * n_frames
        err = validate_shape_frames(tongue_shapes, n_frames, field="tongue_shape_frames")
        if err:
            return err
        err = validate_shape_frames(lip_shapes, n_frames, field="lip_shape_frames")
        if err:
            return err

        manual_roots = payload.get("manual_root_frames") if payload.get("manual_root_frames") is not None else [bool(payload.get("manual_root", False))] * n_frames
        if not isinstance(manual_roots, list) or len(manual_roots) != n_frames or any(type(mode) is not bool for mode in manual_roots):
            return validation_error("manual_root_frames", "舌根模式控制帧须为等长布尔值列表")

        shimmer_val = payload.get("shimmer", 0.0)
        err = validate_scalar_range("shimmer", shimmer_val, 0.0, 100.0, "%")
        if err:
            return err
        flutter_val = payload.get("flutter", eng_probe.default_flutter)
        err = validate_scalar_range("flutter", flutter_val, 0.0, 100.0, "%")
        if err:
            return err
        seed_raw = payload.get("seed", 20261120)
        if type(seed_raw) is not int:
            return validation_error("seed", "seed 必须为整数")

        shimmer = float(shimmer_val)
        flutter = float(flutter_val)
        seed = seed_raw

        assert f0_arr is not None and pr_arr is not None and tract_arr is not None
        assert lip_widths is not None and larynx_heights is not None

        # T-21: Apply raised-cosine bell overlays when editing a reference trajectory without IPA2Tract-Lite
        raw_spans = payload.get("segment_edits") or (payload.get("articulation_spans") if not payload.get("bell_modulated") else None)
        if isinstance(raw_spans, list) and speaker in ("JD2", "JD2-2D"):
            from keyframe_lite import apply_keyframe_bell_overlays_tract19

            tract_mod, bell_err = apply_keyframe_bell_overlays_tract19(
                tract_arr, raw_spans, field_prefix="segment_edits" if "segment_edits" in payload else "articulation_spans",
            )
            if bell_err:
                return bell_err
            assert tract_mod is not None
            tract_arr = tract_mod

        # T-22: Extract physiological trill intervals if not already modulated at >=200 Hz
        active_trill_spans: List[Tuple[float, float, str]] = []
        if not payload.get("trill_modulated") and speaker in ("JD2", "JD2-2D"):
            for item in (payload.get("trill_spans") or []):
                if isinstance(item, (list, tuple)) and len(item) == 3:
                    pl = resolve_trill_place(str(item[2]))
                    if pl and is_finite_number(item[0]) and is_finite_number(item[1]) and float(item[1]) > float(item[0]):
                        active_trill_spans.append((float(item[0]), float(item[1]), pl))
                elif isinstance(item, dict):
                    pl = resolve_trill_place(item.get("place") or item.get("trill") or item.get("ipa"))
                    s_t, e_t = item.get("start_s"), item.get("end_s")
                    if pl and is_finite_number(s_t) and is_finite_number(e_t) and float(e_t) > float(s_t):
                        active_trill_spans.append((float(s_t), float(e_t), pl))
            if not active_trill_spans and isinstance(payload.get("articulation_spans"), list):
                for sp in payload["articulation_spans"]:
                    if not isinstance(sp, dict):
                        continue
                    phase = sp.get("phase", "normal")
                    if phase in ("silence", "closure", "aspiration"):
                        continue
                    pl = resolve_trill_place(sp.get("trill") or sp.get("ipa"))
                    a_f, b_f = sp.get("start_frame"), sp.get("end_frame")
                    if pl and type(a_f) is int and type(b_f) is int and 0 <= a_f < b_f <= n_frames:
                        active_trill_spans.append((a_f / float(step_hz), b_f / float(step_hz), pl))
            if active_trill_spans and step_hz >= 200:
                tract_arr = apply_trill_to_tract19(
                    tract_arr, active_trill_spans, float(step_hz),
                    names=eng_probe.names, minimum=eng_probe.minimum, maximum=eng_probe.maximum,
                )
                active_trill_spans = []  # Already baked at >=200 Hz resolution!

        t_start_synth = time.perf_counter()
        target_sc = DEFAULT_SECTIONS if not speaker.endswith("-2D") else None

        # Fast lossless/physically-exact path when per-frame geometry export is not requested:
        # 1) Skip contiguous PR==0 dead-silence runs >= 250ms (0 dB bit-exact; finish_synthesis zeroes them)
        # 2) Split at true silence gaps (0 dB bit-exact) or breath/phrase valleys & closures (160 ms warm-up + smooth crossfade)
        # 3) Per-pose 3D tube LRU cache + GIL-free 8-worker parallel `prepare_tube`
        # 4) Per-chunk BLAKE2b audio LRU cache + GIL-free 8-worker parallel `block_tube`
        if not include_geometry and not active_trill_spans:
            art_spans = payload.get("articulation_spans") if isinstance(payload.get("articulation_spans"), list) else None
            chunks, skipped_dead_frames = plan_vtl_chunks(
                pr_arr, step_hz, articulation_spans=art_spans,
            )
            full_raw, vtl_stats = self._execute_vtl_chunks(
                speaker=speaker,
                eng_probe=eng_probe,
                target_sc=target_sc,
                step_hz=step_hz,
                step_samples=step_samples,
                n_frames=n_frames,
                f0_arr=f0_arr,
                pr_arr=pr_arr,
                tract_arr=tract_arr,
                glot_arr=glot_arr,
                lip_widths=lip_widths,
                larynx_heights=larynx_heights,
                tongue_shapes=tongue_shapes,
                lip_shapes=lip_shapes,
                manual_roots=manual_roots,
                shimmer=shimmer,
                flutter=flutter,
                seed=seed,
                per_frame_shimmer=per_frame_shimmer,
                chunks=chunks,
                skipped_dead_frames=skipped_dead_frames,
                t_start_synth=t_start_synth,
            )
            wav_f64 = apply_synthesis_gain(
                finish_synthesis(full_raw, pr_arr, step_samples, sample_count),
                payload.get("audio_gain"),
            )
            wav_bytes = pcm_float_to_wav_bytes(wav_f64, SAMPLE_RATE_HZ)
            fast_res: Dict[str, Any] = {
                "ok": True,
                "speaker": speaker,
                "sample_rate_hz": SAMPLE_RATE_HZ,
                "num_frames": n_frames,
                "duration_s": sample_count / float(SAMPLE_RATE_HZ),
                "wav_base64": base64.b64encode(wav_bytes).decode("ascii"),
                "geometry_frames": [],
                "source_badge": "物理管段通道 (VTL 2.4)",
                "interpolation_note": "逐帧真实声道几何",
                "vtl_stats": vtl_stats,
                "chunk_stats": {
                    "total_chunks": vtl_stats["total_phrases"],
                    "cache_hits": vtl_stats["phrase_cache_hits"],
                    "parallel_workers": vtl_stats["parallel_workers"],
                    "wall_ms": vtl_stats["wall_ms"],
                },
            }
            if payload.get("return_control_track"):
                fast_res["tract_control_50hz"] = resample_tract_frames_to_50hz(tract_arr, step_hz, sample_count)
            return fast_res

        with self.lease(speaker, manual_root=manual_roots[0], section_count=target_sc) as eng:
            eng.configure_perturbation({"jitter": 0.0, "shimmer": shimmer, "flutter": flutter, "seed": seed}, restart=True)
            audio_chunks: List[np.ndarray] = []
            geometry_frames: List[Dict[str, Any]] = []
            stride = max(1, int(round(step_hz / fps)))
            glottis_geometry_names = ("x_bottom", "x_top", "chink_area", "lag", "rel_amp", "pulse_shape", "flutter")
            glottis_geometry_indices = [eng.gnames.index(name) for name in glottis_geometry_names]
            idx_xb = eng.gnames.index("x_bottom")
            idx_xt = eng.gnames.index("x_top")
            idx_ca = eng.gnames.index("chink_area")
            idx_lag = eng.gnames.index("lag")
            idx_ra = eng.gnames.index("rel_amp")
            idx_ps = eng.gnames.index("pulse_shape")
            idx_fl = eng.gnames.index("flutter")

            def build_glottis_row(idx: int) -> np.ndarray:
                g = eng.gneutral.copy()
                g[0] = float(f0_arr[idx])
                g[1] = float(pr_arr[idx]) * 10.0  # Pa -> dPa strictly at native boundary
                g[idx_fl] = flutter
                if glot_arr is not None:
                    gf = glot_arr[idx]
                    g[idx_xb] = float(gf[0])
                    g[idx_xt] = float(gf[1])
                    g[idx_ca] = float(gf[2])
                    g[idx_lag] = float(gf[3])
                    g[idx_ra] = float(gf[4])
                    g[idx_ps] = float(gf[5])
                    g[idx_fl] = float(gf[6])
                return np.clip(g, eng.gmin, eng.gmax)

            def pose_signature(idx: int) -> Tuple[Any, ...]:
                ts = None if tongue_shapes[idx] is None else tuple(float(v) for v in tongue_shapes[idx])
                ls = None if lip_shapes[idx] is None else tuple(float(v) for v in lip_shapes[idx])
                return (tuple(tract_arr[idx].tolist()), float(lip_widths[idx]), float(larynx_heights[idx]), ts, ls, manual_roots[idx])

            first_p = eng.validated(tract_arr[0])
            first_tube = eng.prepare_tube(first_p, float(lip_widths[0]), float(larynx_heights[0]), tongue_shapes[0], lip_shapes[0])
            first_g = build_glottis_row(0)
            initial_glottis = first_g.copy()
            initial_glottis[1] = 0.0
            eng.reset_tube(first_tube, np.ascontiguousarray(initial_glottis))
            previous_sig = pose_signature(0)
            previous_manual = manual_roots[0]
            p_vec = first_p
            tube = first_tube

            for i in range(n_frames):
                sig = pose_signature(i)
                if i > 0 and sig != previous_sig:
                    if manual_roots[i] != previous_manual:
                        eng.set_manual_root(manual_roots[i])
                        previous_manual = manual_roots[i]
                    p_vec = eng.validated(tract_arr[i])
                    tube = eng.prepare_tube(p_vec, float(lip_widths[i]), float(larynx_heights[i]), tongue_shapes[i], lip_shapes[i])
                    previous_sig = sig
                g_vec = first_g if i == 0 else build_glottis_row(i)
                if per_frame_shimmer and glot_arr is not None and glot_arr.shape[1] >= 8:
                    frame_shimmer = float(glot_arr[i, 7])
                    if frame_shimmer != shimmer:
                        eng.configure_perturbation({"jitter": 0.0, "shimmer": frame_shimmer, "flutter": flutter, "seed": seed})
                        shimmer = frame_shimmer
                t_frame_start = i / float(step_hz)
                t_frame_end = (i + 1) / float(step_hz)
                in_low_hz_trill = bool(
                    active_trill_spans
                    and any(s_t < t_frame_end and e_t > t_frame_start for s_t, e_t, _ in active_trill_spans)
                )
                if in_low_hz_trill:
                    sub_step = 120  # 2.5 ms (400 Hz) physiological sub-stepping for 50/100 Hz input frames
                    sub_chunks: List[np.ndarray] = []
                    base_pose_dict = {"params": p_vec.tolist()}
                    for sub_off in range(0, step_samples, sub_step):
                        cnt = min(sub_step, step_samples - sub_off)
                        t_mid = (i * step_samples + sub_off + 0.5 * cnt) / float(SAMPLE_RATE_HZ)
                        mod_pose = apply_trill(eng, base_pose_dict, active_trill_spans, t_mid)
                        p_sub = eng.validated(mod_pose["params"])
                        sub_tube = eng.prepare_tube(
                            p_sub, float(lip_widths[i]), float(larynx_heights[i]), tongue_shapes[i], lip_shapes[i],
                        )
                        sub_chunks.append(eng.block_tube(sub_tube, np.ascontiguousarray(g_vec), cnt))
                    pcm = np.concatenate(sub_chunks)
                    previous_sig = None  # Force clean tube restore on next frame
                else:
                    pcm = eng.block_tube(tube, np.ascontiguousarray(g_vec), step_samples)
                audio_chunks.append(pcm)

                if include_geometry and (i % stride == 0 or i == n_frames - 1):
                    with eng.geometry_lock:
                        contours = eng._current_contours()
                        _, _, nasal_port = eng._current_nasal()
                        mag = np.empty(4096)
                        phase = np.empty(4096)
                        eng.geom.p2_transfer(4096, dp(mag), dp(phase))
                    freq, db, resonances = eng._transfer_peaks(mag)
                    keep = freq <= 5000.0
                    areas = tube["areas"]
                    lengths = tube["lengths"]
                    geometry_frames.append(
                        {
                            "t_s": round(i / float(step_hz), 4),
                            "params": p_vec.round(5).tolist(),
                            "contours": contours,
                            "tube_areas": areas.round(5).tolist(),
                            "tube_lengths": lengths.round(5).tolist(),
                            "oral_min_area_cm2": round(float(areas[16:].min()), 5),
                            "nasal_area_cm2": round(max(0.0001, float(nasal_port[1])), 5),
                            "resonances_hz": [float(r) for r in resonances[:3]],
                            "frequency_hz": freq[keep][::4].round(1).tolist(),
                            "transfer_db": db[keep][::4].round(2).tolist(),
                            "f0_hz": round(float(f0_arr[i]), 2),
                            "pressure_pa": round(float(pr_arr[i]), 2),
                            "glottis": [round(float(g_vec[index]), 5) for index in glottis_geometry_indices] + [shimmer],
                        }
                    )

            wav_f64 = apply_synthesis_gain(
                finish_synthesis(np.concatenate(audio_chunks), pr_arr, step_samples, sample_count),
                payload.get("audio_gain"),
            )
            wav_bytes = pcm_float_to_wav_bytes(wav_f64, SAMPLE_RATE_HZ)

            full_res_out: Dict[str, Any] = {
                "ok": True,
                "speaker": speaker,
                "sample_rate_hz": SAMPLE_RATE_HZ,
                "num_frames": n_frames,
                "duration_s": sample_count / float(SAMPLE_RATE_HZ),
                "wav_base64": base64.b64encode(wav_bytes).decode("ascii"),
                "geometry_frames": geometry_frames,
                "source_badge": "物理管段通道 (VTL 2.4)",
                "interpolation_note": "中间显示帧为可视化插值" if fps > 30 and stride > 1 else "逐帧真实声道几何",
            }
            if payload.get("return_control_track"):
                full_res_out["tract_control_50hz"] = resample_tract_frames_to_50hz(tract_arr, step_hz, sample_count)
            return full_res_out

    def _execute_vtl_chunks(
        self,
        *,
        speaker: str,
        eng_probe: Engine,
        target_sc: Optional[int],
        step_hz: int,
        step_samples: int,
        n_frames: int,
        f0_arr: np.ndarray,
        pr_arr: np.ndarray,
        tract_arr: np.ndarray,
        glot_arr: Optional[np.ndarray],
        lip_widths: np.ndarray,
        larynx_heights: np.ndarray,
        tongue_shapes: Sequence[Any],
        lip_shapes: Sequence[Any],
        manual_roots: Sequence[bool],
        shimmer: float,
        flutter: float,
        seed: int,
        per_frame_shimmer: bool,
        chunks: Sequence[Tuple[int, int, str, str]],
        skipped_dead_frames: int,
        t_start_synth: float,
    ) -> Tuple[np.ndarray, Dict[str, Any]]:
        """Execute planned VTL chunks with tube cache, chunk cache, and 8-worker GIL-free parallelism."""
        total_raw_samples = n_frames * step_samples
        if not chunks:
            return np.zeros(total_raw_samples, dtype=np.float64), {
                "total_phrases": 0,
                "phrase_cache_hits": 0,
                "tube_cache_hits": 0,
                "tube_computed": 0,
                "skipped_dead_frames": skipped_dead_frames,
                "parallel_workers": 1,
                "wall_ms": round((time.perf_counter() - t_start_synth) * 1000.0, 1),
            }

        idx_xb = eng_probe.gnames.index("x_bottom")
        idx_xt = eng_probe.gnames.index("x_top")
        idx_ca = eng_probe.gnames.index("chink_area")
        idx_lag = eng_probe.gnames.index("lag")
        idx_ra = eng_probe.gnames.index("rel_amp")
        idx_ps = eng_probe.gnames.index("pulse_shape")
        idx_fl = eng_probe.gnames.index("flutter")
        gneutral = eng_probe.gneutral.copy()
        gmin = eng_probe.gmin.copy()
        gmax = eng_probe.gmax.copy()

        warmup_fr = max(4, int(round(VTL_WARMUP_SEC * step_hz)))
        valley_xf_smp = max(step_samples, int(round(VTL_VALLEY_XFADE_SEC * SAMPLE_RATE_HZ)))
        voiced_xf_smp = max(step_samples, int(round(VTL_VOICED_XFADE_SEC * SAMPLE_RATE_HZ)))
        max_lag_smp = int(round(VTL_ALIGN_MAX_LAG_SEC * SAMPLE_RATE_HZ))
        post_fr = int(np.ceil((voiced_xf_smp + max_lag_smp) / float(step_samples))) + 1

        def _build_glottis_matrix(a: int, b: int) -> np.ndarray:
            m = b - a
            mat = np.repeat(gneutral[None, :], m, axis=0)
            mat[:, 0] = f0_arr[a:b]
            mat[:, 1] = pr_arr[a:b] * 10.0  # Pa -> dPa strictly at native boundary
            mat[:, idx_fl] = flutter
            if glot_arr is not None:
                sub_g = glot_arr[a:b]
                mat[:, idx_xb] = sub_g[:, 0]
                mat[:, idx_xt] = sub_g[:, 1]
                mat[:, idx_ca] = sub_g[:, 2]
                mat[:, idx_lag] = sub_g[:, 3]
                mat[:, idx_ra] = sub_g[:, 4]
                mat[:, idx_ps] = sub_g[:, 5]
                mat[:, idx_fl] = sub_g[:, 6]
            return np.ascontiguousarray(np.clip(mat, gmin, gmax), dtype=np.float64)

        def _chunk_hash(sf: int, ef: int, g_mat: np.ndarray) -> str:
            h = hashlib.blake2b(digest_size=16)
            h.update(f"v2|{speaker}|{target_sc}|{step_hz}|{seed}|{shimmer:.4f}|{flutter:.4f}|{per_frame_shimmer}|".encode("ascii"))
            h.update(np.ascontiguousarray(tract_arr[sf:ef], dtype=np.float64).tobytes())
            h.update(g_mat.tobytes())
            h.update(np.ascontiguousarray(lip_widths[sf:ef], dtype=np.float64).tobytes())
            h.update(np.ascontiguousarray(larynx_heights[sf:ef], dtype=np.float64).tobytes())
            if per_frame_shimmer and glot_arr is not None and glot_arr.shape[1] >= 8:
                h.update(np.ascontiguousarray(glot_arr[sf:ef, 7], dtype=np.float64).tobytes())
            h.update(bytes(1 if m else 0 for m in manual_roots[sf:ef]))
            for idx_s in range(sf, ef):
                ts = tongue_shapes[idx_s]
                ls = lip_shapes[idx_s]
                if ts is not None:
                    h.update(f"T{idx_s - sf}:{ts}".encode("ascii"))
                if ls is not None:
                    h.update(f"L{idx_s - sf}:{ls}".encode("ascii"))
            return h.hexdigest()

        chunk_meta: List[Tuple[int, int, int, int, str, str]] = []
        chunk_pcms: List[Optional[np.ndarray]] = [None] * len(chunks)
        missed_items: List[Tuple[int, int, int, np.ndarray, str]] = []
        phrase_cache_hits = 0

        for ci, (a, b, lk, rk) in enumerate(chunks):
            sf = a if lk == "silence" else max(0, a - warmup_fr)
            ef = b if rk == "silence" else min(n_frames, b + post_fr)
            chunk_meta.append((sf, ef, a, b, lk, rk))
            g_mat = _build_glottis_matrix(sf, ef)
            ckey = _chunk_hash(sf, ef, g_mat)
            cached = _VTL_PHRASE_CACHE.get(ckey)
            expected_len = (ef - sf) * step_samples
            if cached is not None and len(cached) == expected_len:
                chunk_pcms[ci] = cached
                phrase_cache_hits += 1
            else:
                missed_items.append((ci, sf, ef, g_mat, ckey))

        tube_cache_hits = 0
        tube_computed = 0
        workers_used = 1

        if missed_items:
            frame_keys: Dict[int, Tuple[Any, ...]] = {}
            pose_specs: List[Tuple[Tuple[Any, ...], np.ndarray, float, float, Optional[Sequence[float]], Optional[Sequence[float]], bool]] = []
            for _, sf, ef, _, _ in missed_items:
                for i in range(sf, ef):
                    if i in frame_keys:
                        continue
                    k = _make_pose_cache_key(
                        speaker, target_sc, manual_roots[i], tract_arr[i],
                        float(lip_widths[i]), float(larynx_heights[i]), tongue_shapes[i], lip_shapes[i],
                    )
                    frame_keys[i] = k
                    pose_specs.append((
                        k, tract_arr[i], float(lip_widths[i]), float(larynx_heights[i]),
                        tongue_shapes[i], lip_shapes[i], manual_roots[i],
                    ))
            tubes_by_key, tube_cache_hits, tube_computed, prep_workers = self.prepare_tubes_batch(
                speaker, pose_specs, section_count=target_sc,
            )
            workers_used = max(workers_used, prep_workers)

            def _run_chunk(
                worker: Tuple[Engine, threading.RLock],
                item: Tuple[int, int, int, np.ndarray, str],
            ) -> Tuple[int, np.ndarray]:
                ci_local, sf_l, ef_l, g_mat_l, ckey_l = item
                eng, lock = worker
                is_3d = not speaker.endswith("-2D")
                parts_local: List[np.ndarray] = []
                cur_shim = shimmer
                with self._acquire_lock(lock, speaker):
                    prev_sc = int(eng.section_count) if is_3d else None
                    prev_pert = dict(eng.perturbation) if isinstance(eng.perturbation, dict) else None
                    prev_flutter = float(eng.flutter)
                    try:
                        if is_3d and target_sc is not None and eng.section_count != target_sc:
                            eng.set_section_count(target_sc)
                        eng.configure_perturbation({"jitter": 0.0, "shimmer": cur_shim, "flutter": flutter, "seed": seed}, restart=True)
                        first_tube = tubes_by_key[frame_keys[sf_l]]
                        init_g = g_mat_l[0].copy()
                        init_g[1] = 0.0
                        eng.reset_tube(first_tube, np.ascontiguousarray(init_g))
                        for rel_i, abs_i in enumerate(range(sf_l, ef_l)):
                            if per_frame_shimmer and glot_arr is not None and glot_arr.shape[1] >= 8:
                                f_shim = float(glot_arr[abs_i, 7])
                                if f_shim != cur_shim:
                                    eng.configure_perturbation({"jitter": 0.0, "shimmer": f_shim, "flutter": flutter, "seed": seed})
                                    cur_shim = f_shim
                            parts_local.append(eng.block_tube(tubes_by_key[frame_keys[abs_i]], np.ascontiguousarray(g_mat_l[rel_i]), step_samples))
                    finally:
                        try:
                            if is_3d and prev_sc is not None and eng.section_count != prev_sc:
                                eng.set_section_count(prev_sc)
                            eng.configure_perturbation(prev_pert, restart=True)
                            eng.flutter = prev_flutter
                        except Exception:
                            pass
                pcm_arr = np.ascontiguousarray(np.concatenate(parts_local), dtype=np.float64)
                _VTL_PHRASE_CACHE.put(ckey_l, pcm_arr, int(pcm_arr.nbytes))
                return ci_local, pcm_arr

            desired_b_workers = min(VTL_PARALLEL_WORKERS, len(missed_items))
            b_workers = self._get_worker_pool(speaker, desired_b_workers)
            workers_used = max(workers_used, len(b_workers))
            if len(b_workers) == 1 or len(missed_items) == 1:
                for item in missed_items:
                    ci_res, pcm_arr = _run_chunk(b_workers[0], item)
                    chunk_pcms[ci_res] = pcm_arr
            else:
                # Assign missed chunks round-robin to isolated VTL engines; run worker 0's batch on calling thread
                w_buckets: List[List[Tuple[int, int, int, np.ndarray, str]]] = [[] for _ in b_workers]
                for mi, item in enumerate(missed_items):
                    w_buckets[mi % len(b_workers)].append(item)

                def _run_bucket(wi: int) -> List[Tuple[int, np.ndarray]]:
                    return [_run_chunk(b_workers[wi], it) for it in w_buckets[wi]]

                with ThreadPoolExecutor(max_workers=len(b_workers) - 1) as pool:
                    futs = [pool.submit(_run_bucket, wi) for wi in range(1, len(b_workers)) if w_buckets[wi]]
                    if w_buckets[0]:
                        for ci_res, pcm_arr in _run_bucket(0):
                            chunk_pcms[ci_res] = pcm_arr
                    for fut in futs:
                        for ci_res, pcm_arr in fut.result():
                            chunk_pcms[ci_res] = pcm_arr

        # Stitch chunks into full_raw with exact zero-drift valley crossfades & pitch-aligned voiced crossfades
        full_raw = np.zeros(total_raw_samples, dtype=np.float64)
        prev_end_lag = 0
        prev_b = -1
        prev_sf = 0
        prev_pcm: Optional[np.ndarray] = None

        for ci, (sf, ef, a, b, lk, rk) in enumerate(chunk_meta):
            pcm = chunk_pcms[ci]
            assert pcm is not None
            core_off = (a - sf) * step_samples
            core_len = (b - a) * step_samples
            dst_off = a * step_samples
            if ci == 0 or lk == "silence" or prev_b != a or prev_pcm is None:
                full_raw[dst_off : dst_off + core_len] = pcm[core_off : core_off + core_len]
                prev_end_lag = 0
            else:
                xf_smp = valley_xf_smp if lk in ("valley", "closure") else voiced_xf_smp
                xf_smp = min(xf_smp, core_len // 2)
                prev_off = (a - prev_sf) * step_samples + prev_end_lag
                if prev_off < 0 or prev_off + xf_smp > len(prev_pcm) or xf_smp <= 0:
                    full_raw[dst_off : dst_off + core_len] = pcm[core_off : core_off + core_len]
                    prev_end_lag = 0
                else:
                    prev_tail = prev_pcm[prev_off : prev_off + xf_smp]
                    lag = (
                        _find_pitch_aligned_lag(prev_tail, pcm, core_off, core_len, xf_smp, max_lag_smp)
                        if lk == "voiced"
                        else 0
                    )
                    w = 0.5 * (1.0 - np.cos(np.pi * (np.arange(xf_smp, dtype=np.float64) + 0.5) / xf_smp))
                    cur_start = core_off + lag
                    blend = prev_tail * (1.0 - w) + pcm[cur_start : cur_start + xf_smp] * w
                    full_raw[dst_off : dst_off + xf_smp] = blend
                    rem_len = core_len - xf_smp
                    avail = pcm[cur_start + xf_smp : cur_start + xf_smp + rem_len]
                    full_raw[dst_off + xf_smp : dst_off + xf_smp + len(avail)] = avail
                    prev_end_lag = lag
            prev_b = b
            prev_sf = sf
            prev_pcm = pcm

        return full_raw, {
            "total_phrases": len(chunks),
            "phrase_cache_hits": phrase_cache_hits,
            "tube_cache_hits": tube_cache_hits,
            "tube_computed": tube_computed,
            "skipped_dead_frames": skipped_dead_frames,
            "parallel_workers": workers_used,
            "wall_ms": round((time.perf_counter() - t_start_synth) * 1000.0, 1),
        }

    def synthesize_dense_stream(
        self,
        payload: Dict[str, Any],
        predicted_rows: Optional[np.ndarray] = None,
    ) -> Iterator[Dict[str, Any]]:
        try:
            yield from self._synthesize_dense_stream_impl(payload, predicted_rows)
        except EngineBusyError as exc:
            yield exc.result

    def _synthesize_dense_stream_impl(
        self,
        payload: Dict[str, Any],
        predicted_rows: Optional[np.ndarray] = None,
    ) -> Iterator[Dict[str, Any]]:
        """Yield streaming NDJSON events (meta -> chunk 0..K-1 -> done) for low-TTFA physical VTL playback.

        Chunk 0 is tube-prepared across all parallel workers and synthesized immediately while remaining chunks
        prepare & synthesize in the background on isolated native VTL workers.
        """
        from scipy.signal import sosfilt, sosfilt_zi
        from audio_transitions import _high_pass

        t_start = time.perf_counter()
        speaker = str(payload.get("speaker", "JD2"))
        f0_hz = payload.get("f0_hz")
        pressure_pa = payload.get("pressure_pa")
        tract_frames = payload.get("tract_frames")
        glottis_frames = payload.get("glottis_frames")

        step_hz, step_err = resolve_dense_step_hz(payload)
        if step_err:
            yield step_err
            return
        assert step_hz is not None

        per_frame_shimmer = payload.get("per_frame_shimmer", False)
        if type(per_frame_shimmer) is not bool:
            yield validation_error("per_frame_shimmer", "per_frame_shimmer 必须为布尔值")
            return
        if not isinstance(f0_hz, list) or not isinstance(pressure_pa, list) or not isinstance(tract_frames, list):
            yield validation_error("dense_channel", "缺少 f0_hz / pressure_pa / tract_frames 数组")
            return
        n_frames = len(f0_hz)
        max_frames = 60 * step_hz
        if not 1 <= n_frames <= max_frames:
            yield out_of_range_error("f0_hz.length", n_frames, 1, max_frames, "frames", "单次 VTL 合成最多 60 秒")
            return
        if len(pressure_pa) != n_frames or len(tract_frames) != n_frames:
            yield validation_error("lengths", f"数组长度不一致: f0={n_frames}, pressure={len(pressure_pa)}, tract={len(tract_frames)}")
            return
        try:
            eng_probe, _ = self.get_engine(speaker)
        except ValueError as exc:
            yield validation_error("speaker", str(exc))
            return

        f0_min_hz = max(F0_MIN_HZ, float(eng_probe.gmin[0]))
        f0_max_hz = min(F0_MAX_HZ, float(eng_probe.gmax[0]))
        f0_arr, err = validate_scalar_series("f0_hz", f0_hz, n_frames, f0_min_hz, f0_max_hz, "Hz")
        if err:
            if err["error"].get("code") == "out_of_range":
                err["error"]["hint"] = (
                    f"{err['error']['field']} ({err['error']['value']} Hz) 超出 VTL 2.4 物理声门原生范围 "
                    f"[{f0_min_hz:g}, {f0_max_hz:g}] Hz；请切换 Tract2Vox-Lite 神经合成或调整音高"
                )
            yield err
            return
        pr_arr, err = validate_scalar_series("pressure_pa", pressure_pa, n_frames, PRESSURE_MIN_PA, PRESSURE_MAX_PA, "Pa")
        if err:
            yield err
            return
        tract_arr, err = validate_tract19_frames(
            tract_frames, eng_probe.names, eng_probe.minimum, eng_probe.maximum, field="tract_frames", expected_len=n_frames,
        )
        if err:
            yield err
            return
        glot_arr: Optional[np.ndarray] = None
        if glottis_frames is not None:
            glot_arr, err = validate_glottis_frames(glottis_frames, n_frames, field="glottis_frames")
            if err:
                yield err
                return
        step_samples = SAMPLE_RATE_HZ // step_hz
        sample_count = payload.get("sample_count", n_frames * step_samples)
        if type(sample_count) is not int or not (n_frames - 1) * step_samples < sample_count <= n_frames * step_samples:
            yield out_of_range_error("sample_count", sample_count, (n_frames - 1) * step_samples + 1, n_frames * step_samples, "samples")
            return

        lip_widths_raw = payload.get("lip_width_frames") if payload.get("lip_width_frames") is not None else [1.0] * n_frames
        larynx_heights_raw = payload.get("larynx_height_frames") if payload.get("larynx_height_frames") is not None else [0.0] * n_frames
        lip_widths, err = validate_scalar_series("lip_width_frames", lip_widths_raw, n_frames, 0.55, 1.6, "ratio")
        if err:
            yield err
            return
        larynx_heights, err = validate_scalar_series("larynx_height_frames", larynx_heights_raw, n_frames, -1.0, 1.0, "cm")
        if err:
            yield err
            return
        tongue_shapes = payload.get("tongue_shape_frames") if payload.get("tongue_shape_frames") is not None else [payload.get("tongue_shape")] * n_frames
        lip_shapes = payload.get("lip_shape_frames") if payload.get("lip_shape_frames") is not None else [payload.get("lip_shape")] * n_frames
        err = validate_shape_frames(tongue_shapes, n_frames, field="tongue_shape_frames")
        if err:
            yield err
            return
        err = validate_shape_frames(lip_shapes, n_frames, field="lip_shape_frames")
        if err:
            yield err
            return
        manual_roots = payload.get("manual_root_frames") if payload.get("manual_root_frames") is not None else [bool(payload.get("manual_root", False))] * n_frames
        if not isinstance(manual_roots, list) or len(manual_roots) != n_frames or any(type(mode) is not bool for mode in manual_roots):
            yield validation_error("manual_root_frames", "舌根模式控制帧须为等长布尔值列表")
            return
        shimmer_val = payload.get("shimmer", 0.0)
        err = validate_scalar_range("shimmer", shimmer_val, 0.0, 100.0, "%")
        if err:
            yield err
            return
        flutter_val = payload.get("flutter", eng_probe.default_flutter)
        err = validate_scalar_range("flutter", flutter_val, 0.0, 100.0, "%")
        if err:
            yield err
            return
        seed_raw = payload.get("seed", 20261120)
        if type(seed_raw) is not int:
            yield validation_error("seed", "seed 必须为整数")
            return

        shimmer = float(shimmer_val)
        flutter = float(flutter_val)
        seed = seed_raw
        assert f0_arr is not None and pr_arr is not None and tract_arr is not None
        assert lip_widths is not None and larynx_heights is not None

        raw_spans = payload.get("segment_edits") or (payload.get("articulation_spans") if not payload.get("bell_modulated") else None)
        if isinstance(raw_spans, list) and speaker in ("JD2", "JD2-2D"):
            from keyframe_lite import apply_keyframe_bell_overlays_tract19
            tract_mod, bell_err = apply_keyframe_bell_overlays_tract19(
                tract_arr, raw_spans, field_prefix="segment_edits" if "segment_edits" in payload else "articulation_spans",
            )
            if bell_err:
                yield bell_err
                return
            assert tract_mod is not None
            tract_arr = tract_mod

        active_trill_spans: List[Tuple[float, float, str]] = []
        if not payload.get("trill_modulated") and speaker in ("JD2", "JD2-2D"):
            for item in (payload.get("trill_spans") or []):
                if isinstance(item, (list, tuple)) and len(item) == 3:
                    pl = resolve_trill_place(str(item[2]))
                    if pl and is_finite_number(item[0]) and is_finite_number(item[1]) and float(item[1]) > float(item[0]):
                        active_trill_spans.append((float(item[0]), float(item[1]), pl))
                elif isinstance(item, dict):
                    pl = resolve_trill_place(item.get("place") or item.get("trill") or item.get("ipa"))
                    s_t, e_t = item.get("start_s"), item.get("end_s")
                    if pl and is_finite_number(s_t) and is_finite_number(e_t) and float(e_t) > float(s_t):
                        active_trill_spans.append((float(s_t), float(e_t), pl))
            if not active_trill_spans and isinstance(payload.get("articulation_spans"), list):
                for sp in payload["articulation_spans"]:
                    if not isinstance(sp, dict) or sp.get("phase", "normal") in ("silence", "closure", "aspiration"):
                        continue
                    pl = resolve_trill_place(sp.get("trill") or sp.get("ipa"))
                    a_f, b_f = sp.get("start_frame"), sp.get("end_frame")
                    if pl and type(a_f) is int and type(b_f) is int and 0 <= a_f < b_f <= n_frames:
                        active_trill_spans.append((a_f / float(step_hz), b_f / float(step_hz), pl))
            if active_trill_spans and step_hz >= 200:
                tract_arr = apply_trill_to_tract19(
                    tract_arr, active_trill_spans, float(step_hz),
                    names=eng_probe.names, minimum=eng_probe.minimum, maximum=eng_probe.maximum,
                )
                active_trill_spans = []

        meta_base: Dict[str, Any] = {
            "ok": True,
            "type": "meta",
            "sample_rate_hz": SAMPLE_RATE_HZ,
            "total_samples": sample_count,
            "duration_s": sample_count / float(SAMPLE_RATE_HZ),
            "num_frames": n_frames,
            "speaker": speaker,
            "device_effective": "cpu",
            "source_badge": "VTL 2.4 物理声管",
            "synth_mode": "physical",
        }
        if payload.get("return_control_track"):
            meta_base["tract_control_50hz"] = resample_tract_frames_to_50hz(tract_arr, step_hz, sample_count)
            if predicted_rows is not None:
                c_rows = np.asarray(predicted_rows, dtype=np.float64).copy()
                c_rows[:, 18] /= 10.0
                meta_base["m27_control_50hz_pa"] = c_rows.tolist()

        # Fallback for low-Hz trill sub-stepping: delegate to synthesize_dense and emit 1 chunk
        if active_trill_spans:
            full_res = self.synthesize_dense({**payload, "include_geometry": False})
            if not full_res.get("ok"):
                yield full_res
                return
            raw_wav = base64.b64decode(full_res["wav_base64"])
            with wave.open(io.BytesIO(raw_wav), "rb") as wf:
                pcm_bytes = wf.readframes(wf.getnframes())
            yield {**meta_base, "total_chunks": 1, "parallel_workers": 1, "cut_reasons": ["whole"]}
            yield {
                "ok": True,
                "type": "chunk",
                "index": 0,
                "total_chunks": 1,
                "start_sample": 0,
                "core_start_sample": 0,
                "sample_count": len(pcm_bytes) // 2,
                "overlap_left_samples": 0,
                "left_is_silence": True,
                "right_is_silence": True,
                "cut_reason": "whole",
                "cache_hit": False,
                "model_ms": round((time.perf_counter() - t_start) * 1000.0, 1),
                "pcm_i16_b64": base64.b64encode(pcm_bytes).decode("ascii"),
            }
            yield {
                "ok": True,
                "type": "done",
                "total_chunks": 1,
                "cache_hits": 0,
                "parallel_workers": 1,
                "model_ms": round((time.perf_counter() - t_start) * 1000.0),
            }
            return

        target_sc = DEFAULT_SECTIONS if not speaker.endswith("-2D") else None
        art_spans = payload.get("articulation_spans") if isinstance(payload.get("articulation_spans"), list) else None
        chunks, skipped_dead_frames = plan_vtl_chunks(
            pr_arr,
            step_hz,
            articulation_spans=art_spans,
            target_chunk_s=5.8,
            min_chunk_s=2.4,
            first_chunk_max_s=4.5 if n_frames > int(8.0 * step_hz) else None,
        )

        # All-silent track shortcut (0 ms)
        if not chunks:
            zeros = np.zeros(sample_count, dtype="<i2")
            yield {**meta_base, "total_chunks": 1, "parallel_workers": 1, "cut_reasons": ["silence"]}
            yield {
                "ok": True,
                "type": "chunk",
                "index": 0,
                "total_chunks": 1,
                "start_sample": 0,
                "core_start_sample": 0,
                "sample_count": sample_count,
                "overlap_left_samples": 0,
                "left_is_silence": True,
                "right_is_silence": True,
                "cut_reason": "silence",
                "cache_hit": True,
                "model_ms": 0.1,
                "pcm_i16_b64": base64.b64encode(zeros.tobytes()).decode("ascii"),
            }
            yield {
                "ok": True,
                "type": "done",
                "total_chunks": 1,
                "cache_hits": 1,
                "parallel_workers": 1,
                "model_ms": round((time.perf_counter() - t_start) * 1000.0),
            }
            return

        idx_xb = eng_probe.gnames.index("x_bottom")
        idx_xt = eng_probe.gnames.index("x_top")
        idx_ca = eng_probe.gnames.index("chink_area")
        idx_lag = eng_probe.gnames.index("lag")
        idx_ra = eng_probe.gnames.index("rel_amp")
        idx_ps = eng_probe.gnames.index("pulse_shape")
        idx_fl = eng_probe.gnames.index("flutter")
        gneutral = eng_probe.gneutral.copy()
        gmin = eng_probe.gmin.copy()
        gmax = eng_probe.gmax.copy()

        warmup_fr = max(4, int(round(VTL_WARMUP_SEC * step_hz)))
        valley_xf_smp = max(step_samples, int(round(VTL_VALLEY_XFADE_SEC * SAMPLE_RATE_HZ)))
        voiced_xf_smp = max(step_samples, int(round(VTL_VOICED_XFADE_SEC * SAMPLE_RATE_HZ)))
        max_lag_smp = int(round(VTL_ALIGN_MAX_LAG_SEC * SAMPLE_RATE_HZ))
        post_fr = int(np.ceil((voiced_xf_smp + max_lag_smp) / float(step_samples))) + 1

        def _build_glottis_matrix(a: int, b: int) -> np.ndarray:
            m = b - a
            mat = np.repeat(gneutral[None, :], m, axis=0)
            mat[:, 0] = f0_arr[a:b]
            mat[:, 1] = pr_arr[a:b] * 10.0
            mat[:, idx_fl] = flutter
            if glot_arr is not None:
                sub_g = glot_arr[a:b]
                mat[:, idx_xb] = sub_g[:, 0]
                mat[:, idx_xt] = sub_g[:, 1]
                mat[:, idx_ca] = sub_g[:, 2]
                mat[:, idx_lag] = sub_g[:, 3]
                mat[:, idx_ra] = sub_g[:, 4]
                mat[:, idx_ps] = sub_g[:, 5]
                mat[:, idx_fl] = sub_g[:, 6]
            return np.ascontiguousarray(np.clip(mat, gmin, gmax), dtype=np.float64)

        def _chunk_hash(sf: int, ef: int, g_mat: np.ndarray) -> str:
            h = hashlib.blake2b(digest_size=16)
            h.update(f"v2|{speaker}|{target_sc}|{step_hz}|{seed}|{shimmer:.4f}|{flutter:.4f}|{per_frame_shimmer}|".encode("ascii"))
            h.update(np.ascontiguousarray(tract_arr[sf:ef], dtype=np.float64).tobytes())
            h.update(g_mat.tobytes())
            h.update(np.ascontiguousarray(lip_widths[sf:ef], dtype=np.float64).tobytes())
            h.update(np.ascontiguousarray(larynx_heights[sf:ef], dtype=np.float64).tobytes())
            if per_frame_shimmer and glot_arr is not None and glot_arr.shape[1] >= 8:
                h.update(np.ascontiguousarray(glot_arr[sf:ef, 7], dtype=np.float64).tobytes())
            h.update(bytes(1 if m else 0 for m in manual_roots[sf:ef]))
            for idx_s in range(sf, ef):
                ts = tongue_shapes[idx_s]
                ls = lip_shapes[idx_s]
                if ts is not None:
                    h.update(f"T{idx_s - sf}:{ts}".encode("ascii"))
                if ls is not None:
                    h.update(f"L{idx_s - sf}:{ls}".encode("ascii"))
            return h.hexdigest()

        # Precompute exact per-sample zero-pressure gate envelope matching finish_synthesis()
        gate_full = np.zeros(sample_count, dtype=np.float64)
        edges = np.flatnonzero(np.diff(np.r_[0, pr_arr > 0.0, 0])).astype(np.int64)
        for g_begin, g_end in edges.reshape(-1, 2) * step_samples:
            g_begin = min(int(g_begin), sample_count)
            g_end = min(int(g_end), sample_count)
            if g_end <= g_begin:
                continue
            gate_full[g_begin:g_end] = 1.0
            width = min(round(SAMPLE_RATE_HZ * 0.005), (g_end - g_begin) // 4)
            if width:
                ramp = np.sin(np.linspace(0.0, np.pi / 2.0, width)) ** 2
                gate_full[g_begin : g_begin + width] *= ramp
                gate_full[g_end - width : g_end] *= ramp[::-1]

        chunk_meta: List[Tuple[int, int, int, int, str, str, np.ndarray, str]] = []
        cached_pcms: List[Optional[np.ndarray]] = [None] * len(chunks)
        cache_hits_count = 0
        for ci, (a, b, lk, rk) in enumerate(chunks):
            sf = a if lk == "silence" else max(0, a - warmup_fr)
            ef = b if rk == "silence" else min(n_frames, b + post_fr)
            g_mat = _build_glottis_matrix(sf, ef)
            ckey = _chunk_hash(sf, ef, g_mat)
            chunk_meta.append((sf, ef, a, b, lk, rk, g_mat, ckey))
            hit = _VTL_PHRASE_CACHE.get(ckey)
            if hit is not None and len(hit) == (ef - sf) * step_samples:
                cached_pcms[ci] = hit
                cache_hits_count += 1

        # Count emitted spans (contiguous coverage of [0 .. sample_count))
        n_emitted = len(chunks)
        workers_pool = self._get_worker_pool(speaker, min(VTL_PARALLEL_WORKERS, max(1, len(chunks))))
        yield {
            **meta_base,
            "total_chunks": n_emitted,
            "parallel_workers": len(workers_pool),
            "cut_reasons": [rk for _, _, _, rk in chunks],
        }

        def _prep_frames_range(ranges: Sequence[Tuple[int, int]], *, skip_primary: bool = False) -> Tuple[Dict[int, Tuple[Any, ...]], Dict[Tuple[Any, ...], Dict[str, Any]], int, int]:
            fkeys: Dict[int, Tuple[Any, ...]] = {}
            pspecs: List[Tuple[Tuple[Any, ...], np.ndarray, float, float, Optional[Sequence[float]], Optional[Sequence[float]], bool]] = []
            for r_sf, r_ef in ranges:
                for i in range(r_sf, r_ef):
                    if i in fkeys:
                        continue
                    k = _make_pose_cache_key(
                        speaker, target_sc, manual_roots[i], tract_arr[i],
                        float(lip_widths[i]), float(larynx_heights[i]), tongue_shapes[i], lip_shapes[i],
                    )
                    fkeys[i] = k
                    pspecs.append((
                        k, tract_arr[i], float(lip_widths[i]), float(larynx_heights[i]),
                        tongue_shapes[i], lip_shapes[i], manual_roots[i],
                    ))
            tmap, thits, tcomp, _ = self.prepare_tubes_batch(
                speaker, pspecs, section_count=target_sc, skip_primary=skip_primary,
            )
            return fkeys, tmap, thits, tcomp

        def _exec_block(
            worker: Tuple[Engine, threading.RLock],
            sf_l: int,
            ef_l: int,
            g_mat_l: np.ndarray,
            ckey_l: str,
            fkeys: Dict[int, Tuple[Any, ...]],
            tmap: Dict[Tuple[Any, ...], Dict[str, Any]],
        ) -> np.ndarray:
            eng, lock = worker
            is_3d = not speaker.endswith("-2D")
            parts_local: List[np.ndarray] = []
            cur_shim = shimmer
            with self._acquire_lock(lock, speaker):
                prev_sc = int(eng.section_count) if is_3d else None
                prev_pert = dict(eng.perturbation) if isinstance(eng.perturbation, dict) else None
                prev_flutter = float(eng.flutter)
                try:
                    if is_3d and target_sc is not None and eng.section_count != target_sc:
                        eng.set_section_count(target_sc)
                    eng.configure_perturbation({"jitter": 0.0, "shimmer": cur_shim, "flutter": flutter, "seed": seed}, restart=True)
                    first_tube = tmap[fkeys[sf_l]]
                    init_g = g_mat_l[0].copy()
                    init_g[1] = 0.0
                    eng.reset_tube(first_tube, np.ascontiguousarray(init_g))
                    for rel_i, abs_i in enumerate(range(sf_l, ef_l)):
                        if per_frame_shimmer and glot_arr is not None and glot_arr.shape[1] >= 8:
                            f_shim = float(glot_arr[abs_i, 7])
                            if f_shim != cur_shim:
                                eng.configure_perturbation({"jitter": 0.0, "shimmer": f_shim, "flutter": flutter, "seed": seed})
                                cur_shim = f_shim
                        parts_local.append(eng.block_tube(tmap[fkeys[abs_i]], np.ascontiguousarray(g_mat_l[rel_i]), step_samples))
                finally:
                    try:
                        if is_3d and prev_sc is not None and eng.section_count != prev_sc:
                            eng.set_section_count(prev_sc)
                        eng.configure_perturbation(prev_pert, restart=True)
                        eng.flutter = prev_flutter
                    except Exception:
                        pass
            pcm_arr = np.ascontiguousarray(np.concatenate(parts_local), dtype=np.float64)
            _VTL_PHRASE_CACHE.put(ckey_l, pcm_arr, int(pcm_arr.nbytes))
            return pcm_arr

        # Stage 1: Prepare tubes for Chunk 0 IMMEDIATELY using all parallel workers
        tube_hits_total = 0
        tube_comp_total = 0
        c0_sf, c0_ef, _, _, _, _, c0_gmat, c0_key = chunk_meta[0]
        c0_fkeys: Dict[int, Tuple[Any, ...]] = {}
        c0_tmap: Dict[Tuple[Any, ...], Dict[str, Any]] = {}
        if cached_pcms[0] is None:
            c0_fkeys, c0_tmap, th0, tc0 = _prep_frames_range([(c0_sf, c0_ef)])
            tube_hits_total += th0
            tube_comp_total += tc0

        # Stage 2: Launch background synthesis of chunks 1..K-1 concurrently while Chunk 0 runs `block_tube`!
        remaining_missed = [ci for ci in range(1, len(chunks)) if cached_pcms[ci] is None]
        rem_futs: Dict[int, Any] = {}
        bg_pool: Optional[ThreadPoolExecutor] = None
        bg_prep_fut = None

        def _bg_prepare_and_run() -> Tuple[Dict[int, np.ndarray], int, int]:
            rfkeys, rtmap, rth, rtc = _prep_frames_range(
                [(chunk_meta[ci][0], chunk_meta[ci][1]) for ci in remaining_missed],
                skip_primary=len(workers_pool) > 1,
            )
            out_map: Dict[int, np.ndarray] = {}
            bg_workers = workers_pool[1:] if len(workers_pool) > 1 else workers_pool
            if len(bg_workers) == 1 or len(remaining_missed) == 1:
                for ci in remaining_missed:
                    sf_i, ef_i, _, _, _, _, gm_i, ck_i = chunk_meta[ci]
                    out_map[ci] = _exec_block(bg_workers[0], sf_i, ef_i, gm_i, ck_i, rfkeys, rtmap)
            else:
                with ThreadPoolExecutor(max_workers=len(bg_workers)) as bpool:
                    sub_futs = {
                        ci: bpool.submit(
                            _exec_block,
                            bg_workers[mi % len(bg_workers)],
                            chunk_meta[ci][0],
                            chunk_meta[ci][1],
                            chunk_meta[ci][6],
                            chunk_meta[ci][7],
                            rfkeys,
                            rtmap,
                        )
                        for mi, ci in enumerate(remaining_missed)
                    }
                    for ci, sfut in sub_futs.items():
                        out_map[ci] = sfut.result()
            return out_map, rth, rtc

        if remaining_missed:
            bg_pool = ThreadPoolExecutor(max_workers=1)
            bg_prep_fut = bg_pool.submit(_bg_prepare_and_run)

        try:
            # Compute Chunk 0 on Worker 0 (or use cache) and yield IMMEDIATELY!
            t_c0 = time.perf_counter()
            if cached_pcms[0] is None:
                cached_pcms[0] = _exec_block(workers_pool[0], c0_sf, c0_ef, c0_gmat, c0_key, c0_fkeys, c0_tmap)
            c0_ms = round((time.perf_counter() - t_c0) * 1000.0, 1)

            sos_hpf = _high_pass(SAMPLE_RATE_HZ)
            hpf_zi = np.zeros((sos_hpf.shape[0], 2), dtype=np.float64)
            audio_gain_mode = payload.get("audio_gain")
            stream_gain: Optional[float] = None
            prev_end_lag = 0
            prev_b = -1
            prev_sf = 0
            prev_pcm: Optional[np.ndarray] = None
            emitted_cursor = 0

            def _postprocess_and_pack(raw_seg: np.ndarray, start_smp: int) -> Tuple[bytes, int]:
                nonlocal hpf_zi, stream_gain
                end_smp = min(sample_count, start_smp + len(raw_seg))
                n_valid = max(0, end_smp - start_smp)
                if n_valid == 0:
                    return b"", 0
                seg, hpf_zi = sosfilt(sos_hpf, raw_seg[:n_valid], zi=hpf_zi)
                seg = seg * gate_full[start_smp:end_smp]
                if audio_gain_mode != "original":
                    if stream_gain is None:
                        pk = float(np.max(np.abs(seg))) if seg.size else 0.0
                        if pk >= MIN_NORMALIZE_PEAK:
                            stream_gain = min(14.0, 0.72 / max(pk, 0.03))
                    if stream_gain is not None:
                        seg = _soft_limit_audio(seg * stream_gain, knee=0.85, ceiling=0.96)
                else:
                    seg = _soft_limit_audio(seg, knee=0.92, ceiling=0.99)
                pcm16 = np.clip(np.round(seg * 32767.0), -32768, 32767).astype("<i2")
                return pcm16.tobytes(), n_valid

            for ci in range(len(chunks)):
                if ci > 0 and cached_pcms[ci] is None and bg_prep_fut is not None:
                    bg_map, rth, rtc = bg_prep_fut.result()
                    bg_prep_fut = None
                    tube_hits_total += rth
                    tube_comp_total += rtc
                    for k_ci, v_pcm in bg_map.items():
                        cached_pcms[k_ci] = v_pcm

                sf, ef, a, b, lk, rk, _, _ = chunk_meta[ci]
                pcm = cached_pcms[ci]
                assert pcm is not None
                core_off = (a - sf) * step_samples
                core_len = (b - a) * step_samples
                dst_start = a * step_samples
                # Stitch boundary seamlessly in float64 against previous chunk tail
                core_pcm = np.empty(core_len, dtype=np.float64)
                if ci == 0 or lk == "silence" or prev_b != a or prev_pcm is None:
                    core_pcm[:] = pcm[core_off : core_off + core_len]
                    prev_end_lag = 0
                else:
                    xf_smp = valley_xf_smp if lk in ("valley", "closure") else voiced_xf_smp
                    xf_smp = min(xf_smp, core_len // 2)
                    prev_off = (a - prev_sf) * step_samples + prev_end_lag
                    if prev_off < 0 or prev_off + xf_smp > len(prev_pcm) or xf_smp <= 0:
                        core_pcm[:] = pcm[core_off : core_off + core_len]
                        prev_end_lag = 0
                    else:
                        prev_tail = prev_pcm[prev_off : prev_off + xf_smp]
                        lag = (
                            _find_pitch_aligned_lag(prev_tail, pcm, core_off, core_len, xf_smp, max_lag_smp)
                            if lk == "voiced"
                            else 0
                        )
                        w = 0.5 * (1.0 - np.cos(np.pi * (np.arange(xf_smp, dtype=np.float64) + 0.5) / xf_smp))
                        cur_start = core_off + lag
                        core_pcm[:xf_smp] = prev_tail * (1.0 - w) + pcm[cur_start : cur_start + xf_smp] * w
                        rem_len = core_len - xf_smp
                        avail = pcm[cur_start + xf_smp : cur_start + xf_smp + rem_len]
                        core_pcm[xf_smp : xf_smp + len(avail)] = avail
                        if len(avail) < rem_len:
                            core_pcm[xf_smp + len(avail) :] = 0.0
                        prev_end_lag = lag

                prev_b = b
                prev_sf = sf
                prev_pcm = pcm

                # Bridge any skipped dead-silence gap before this chunk (and trailing dead silence after final chunk)
                lead_zeros = max(0, dst_start - emitted_cursor)
                trail_zeros = max(0, sample_count - (dst_start + core_len)) if ci == len(chunks) - 1 else 0
                if lead_zeros > 0 or trail_zeros > 0:
                    emit_raw = np.concatenate((
                        np.zeros(lead_zeros, dtype=np.float64),
                        core_pcm,
                        np.zeros(trail_zeros, dtype=np.float64),
                    ))
                    emit_start = emitted_cursor
                else:
                    emit_raw = core_pcm
                    emit_start = dst_start

                pcm_bytes, n_valid = _postprocess_and_pack(emit_raw, emit_start)
                emitted_cursor = emit_start + n_valid
                if n_valid > 0:
                    yield {
                        "ok": True,
                        "type": "chunk",
                        "index": ci,
                        "total_chunks": n_emitted,
                        "start_sample": emit_start,
                        "core_start_sample": dst_start,
                        "sample_count": n_valid,
                        "overlap_left_samples": 0,
                        "left_is_silence": lk == "silence",
                        "right_is_silence": rk == "silence",
                        "cut_reason": rk,
                        "cache_hit": ci not in remaining_missed and (ci > 0 or c0_ms < 5.0),
                        "model_ms": c0_ms if ci == 0 else round((time.perf_counter() - t_start) * 1000.0, 1),
                        "pcm_i16_b64": base64.b64encode(pcm_bytes).decode("ascii"),
                    }
        finally:
            if bg_pool is not None:
                bg_pool.shutdown(wait=False)

        yield {
            "ok": True,
            "type": "done",
            "total_chunks": n_emitted,
            "cache_hits": cache_hits_count,
            "parallel_workers": len(workers_pool),
            "model_ms": round((time.perf_counter() - t_start) * 1000.0),
            "vtl_stats": {
                "total_phrases": len(chunks),
                "phrase_cache_hits": cache_hits_count,
                "tube_cache_hits": tube_hits_total,
                "tube_computed": tube_comp_total,
                "skipped_dead_frames": skipped_dead_frames,
                "parallel_workers": len(workers_pool),
                "wall_ms": round((time.perf_counter() - t_start) * 1000.0, 1),
            },
        }

    def batch_contours(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        try:
            return self._batch_contours_impl(payload)
        except EngineBusyError as exc:
            return exc.result

    def _batch_contours_impl(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Batch-extract real VTL 2.4 mid-sagittal contours + Amin + F1/F2/F3 for up to 64 19-D poses."""
        speaker = str(payload.get("speaker", "JD2"))
        poses = payload.get("poses")
        if not isinstance(poses, list) or len(poses) == 0:
            return validation_error("poses", "poses 必须为非空 19 维构型数组")
        if len(poses) > 64:
            return out_of_range_error("poses.length", len(poses), 1, 64, "poses", "单次批量轮廓提取最多支持 64 帧")

        try:
            eng_probe, _ = self.get_engine(speaker)
        except ValueError as exc:
            return validation_error("speaker", str(exc))

        poses_arr, err = validate_tract19_frames(poses, eng_probe.names, eng_probe.minimum, eng_probe.maximum, field="poses")
        if err:
            return err
        assert poses_arr is not None
        n_poses = len(poses_arr)

        lip_widths_raw = payload.get("lip_width_frames") if payload.get("lip_width_frames") is not None else [1.0] * n_poses
        larynx_heights_raw = payload.get("larynx_height_frames") if payload.get("larynx_height_frames") is not None else [0.0] * n_poses
        lip_widths, err = validate_scalar_series("lip_width_frames", lip_widths_raw, n_poses, 0.55, 1.6, "ratio")
        if err:
            return err
        larynx_heights, err = validate_scalar_series("larynx_height_frames", larynx_heights_raw, n_poses, -1.0, 1.0, "cm")
        if err:
            return err

        tongue_shapes = payload.get("tongue_shape_frames") if payload.get("tongue_shape_frames") is not None else [payload.get("tongue_shape")] * n_poses
        lip_shapes = payload.get("lip_shape_frames") if payload.get("lip_shape_frames") is not None else [payload.get("lip_shape")] * n_poses
        err = validate_shape_frames(tongue_shapes, n_poses, field="tongue_shape_frames")
        if err:
            return err
        err = validate_shape_frames(lip_shapes, n_poses, field="lip_shape_frames")
        if err:
            return err

        manual_roots = payload.get("manual_root_frames") if payload.get("manual_root_frames") is not None else [bool(payload.get("manual_root", False))] * n_poses
        if not isinstance(manual_roots, list) or len(manual_roots) != n_poses or any(type(mode) is not bool for mode in manual_roots):
            return validation_error("manual_root_frames", "舌根模式控制帧须为等长布尔值列表")
        assert lip_widths is not None and larynx_heights is not None

        with self.lease(speaker, manual_root=False, section_count=DEFAULT_SECTIONS if not speaker.endswith("-2D") else None) as eng:
            res_cache = self._resonance_caches[speaker]
            part_sizes: Optional[List[int]] = None
            items: List[Dict[str, Any]] = []
            with_resonances = bool(payload.get("with_resonances", True))
            with eng.geometry_lock:
                for idx, vec19 in enumerate(poses_arr):
                    mr = bool(manual_roots[idx])
                    if bool(eng.manual_root) != mr:
                        eng.set_manual_root(mr)
                    lw = float(lip_widths[idx])
                    lh = float(larynx_heights[idx])
                    ts = tongue_shapes[idx]
                    ls = lip_shapes[idx]
                    contours, nasal_port_area, limited = eng.inversion_profile(vec19, lw, lh, ts, ls)
                    if part_sizes is None:
                        part_sizes = [len(contours[p]) for p in PARTS]
                    tube = eng._current_tube()
                    f1, f2, f3 = 0.0, 0.0, 0.0
                    if with_resonances:
                        ts_key = None if ts is None else tuple(round(float(v), 4) for v in ts)
                        ls_key = None if ls is None else tuple(round(float(v), 4) for v in ls)
                        cache_key = (
                            speaker,
                            int(eng.section_count),
                            mr,
                            tuple(round(float(x), 4) for x in vec19),
                            round(lw, 4),
                            round(lh, 4),
                            ts_key,
                            ls_key,
                        )
                        cached_res = res_cache.get(cache_key)
                        if cached_res is not None:
                            res_cache.move_to_end(cache_key)
                            f1, f2, f3 = cached_res
                        else:
                            mag = np.empty(4096)
                            phase = np.empty(4096)
                            eng.geom.p2_transfer(4096, dp(mag), dp(phase))
                            _, _, resonances = eng._transfer_peaks(mag)
                            f1 = round(float(resonances[0]), 1) if len(resonances) >= 1 else 0.0
                            f2 = round(float(resonances[1]), 1) if len(resonances) >= 2 else 0.0
                            f3 = round(float(resonances[2]), 1) if len(resonances) >= 3 else 0.0
                            res_cache[cache_key] = (f1, f2, f3)
                            if len(res_cache) > 256:
                                res_cache.popitem(last=False)

                    srib = float(eng.geom.p8_surface_rib()) if hasattr(eng, "geom") and eng.geom is not None else 16.0
                    brib = float(eng.geom.p4_blade_rib()) if hasattr(eng, "geom") and eng.geom is not None else 21.0
                    frib = int(eng.geom.p6_floor_rib()) if hasattr(eng, "geom") and eng.geom is not None else 10

                    flat_pts: List[float] = []
                    for part in PARTS:
                        for pt in contours[part]:
                            flat_pts.append(round(float(pt[0]), 2))
                            flat_pts.append(round(float(pt[1]), 2))

                    items.append(
                        {
                            "pts": flat_pts,
                            "nasal": round(float(nasal_port_area), 3),
                            "lm": [round(float(limited[c]), 2) for c in (8, 9, 10, 11, 12, 13, 14, 15)],
                            "srib": round(srib, 3),
                            "brib": round(brib, 3),
                            "frib": frib,
                            "amin_cm2": round(float(tube["areas"][16:].min()), 5),
                            "f1_hz": f1,
                            "f2_hz": f2,
                            "f3_hz": f3,
                        }
                    )

            return {
                "ok": True,
                "schema": "vtl_batch_contours_v1",
                "speaker": speaker,
                "parts": list(PARTS),
                "part_sizes": part_sizes or [],
                "items": items,
            }
