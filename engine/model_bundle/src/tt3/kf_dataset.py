"""Multi-source datasets, hot-swappable canonical IPA pose bank, and online masking for KF2Tract27."""
from __future__ import annotations

from collections import OrderedDict
import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np
import soundfile as sf
import torch
from torch.utils.data import Dataset

from .constants import SAMPLE_RATE_16K, WAVLM_HOP_SAMPLES
from .kf_baseline import (
    DEFAULT_KF26_NEUTRAL_NORM,
    KF_COND_DIM,
    KF_OUT_DIM,
    build_condition_from_segments,
    build_condition_from_sparse_anchors,
    m27_to_kf26,
)
from .kf_phonetics import KF26_INDEX, SegmentEvent
from .m27_contract import (
    DEFAULT_M27_PAD_ROW,
    F0_IDX,
    M27_MAX,
    M27_MIN,
    normalize_m27,
)


class CanonicalPoseBank:
    """Hot-swappable canonical IPA pose library in normalized KF26 [-1, 1] space.

    Reads ``canonical_ipa_poses.json``. Each entry may store either:
      - ``kf26_norm`` (26 floats in [-1, 1])
      - ``m27_phys``  (27 floats in physical JD2 units, auto-normalized)
      - ``tract17_phys`` (17 floats; fills default voiced/voiceless source automatically)
    Users can drop in hand-authored/recorded standard IPA poses at any time without retraining!
    """

    def __init__(self, json_path: Optional[Path] = None) -> None:
        self.poses: Dict[str, np.ndarray] = {}
        self.closure_poses: Dict[str, np.ndarray] = {}
        self.meta: Dict[str, Any] = {}
        if json_path is not None and Path(json_path).is_file():
            self.load(Path(json_path))

    def load(self, json_path: Path) -> None:
        raw = json.loads(Path(json_path).read_text(encoding="utf-8"))
        self.meta = dict(raw.get("meta", {}))
        self.poses.clear()
        self.closure_poses.clear()
        for ipa, entry in raw.get("poses", {}).items():
            vec = self._parse_entry(entry)
            if vec is not None:
                self.poses[str(ipa)] = vec
        for ipa, entry in raw.get("closure_poses", {}).items():
            vec = self._parse_entry(entry)
            if vec is not None:
                self.closure_poses[str(ipa)] = vec

    @staticmethod
    def _parse_entry(entry: Any) -> Optional[np.ndarray]:
        if isinstance(entry, list) and len(entry) == KF_OUT_DIM:
            return np.clip(np.asarray(entry, dtype=np.float32), -1.0, 1.0)
        if not isinstance(entry, dict):
            return None
        if "kf26_norm" in entry and len(entry["kf26_norm"]) == KF_OUT_DIM:
            return np.clip(np.asarray(entry["kf26_norm"], dtype=np.float32), -1.0, 1.0)
        if "m27_phys" in entry and len(entry["m27_phys"]) == 27:
            m27_norm = normalize_m27(np.asarray(entry["m27_phys"], dtype=np.float32))
            return m27_to_kf26(m27_norm).astype(np.float32)
        if "tract17_phys" in entry and len(entry["tract17_phys"]) == 17:
            row = DEFAULT_M27_PAD_ROW.copy()
            row[:17] = np.asarray(entry["tract17_phys"], dtype=np.float32)
            row[18] = 8000.0
            row[23] = 0.90
            m27_norm = normalize_m27(row)
            return m27_to_kf26(m27_norm).astype(np.float32)
        return None

    def lookup(self, seg: SegmentEvent) -> np.ndarray:
        if seg.is_sil or seg.ipa == "sil":
            return self.poses.get("sil", DEFAULT_KF26_NEUTRAL_NORM).copy()
        if seg.is_closure and seg.ipa in self.closure_poses:
            return self.closure_poses[seg.ipa].copy()
        if seg.ipa in self.poses:
            return self.poses[seg.ipa].copy()
        # Fallback: strip aspiration/diacritic marks if exact symbol absent
        base = seg.ipa.replace("ʰ", "").replace("̩", "").replace("ː", "")
        if seg.is_closure and base in self.closure_poses:
            return self.closure_poses[base].copy()
        if base in self.poses:
            return self.poses[base].copy()
        return DEFAULT_KF26_NEUTRAL_NORM.copy()

    def save(self, json_path: Path, counts: Optional[Dict[str, int]] = None) -> None:
        json_path = Path(json_path)
        json_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "schema": "kf2tract27_canonical_poses_v1",
            "meta": self.meta,
            "counts": counts or {},
            "poses": {k: {"kf26_norm": [round(float(x), 5) for x in v]} for k, v in sorted(self.poses.items())},
            "closure_poses": {
                k: {"kf26_norm": [round(float(x), 5) for x in v]}
                for k, v in sorted(self.closure_poses.items())
            },
        }
        json_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


# Organ groups used for realistic structured random masking during Stage K1 / unlabeled masking
_ORGAN_GROUPS: Tuple[Tuple[str, ...], ...] = (
    ("LD", "LP"),
    ("TTX", "TTY", "TBX", "TBY"),
    ("TCX", "TCY"),
    ("JA", "JX"),
    ("VO", "VS"),
    ("HX", "HY"),
    ("TS1", "TS2", "TS3"),
    ("PR", "XB", "XT", "CA", "RA"),
    ("LAG", "PS", "FL", "SHIM"),
)
_ORGAN_GROUP_IDXS: Tuple[np.ndarray, ...] = tuple(
    np.array([KF26_INDEX[n] for n in grp], dtype=np.int64) for grp in _ORGAN_GROUPS
)


def sample_sparse_anchors_from_trajectory(
    kf26_norm: np.ndarray,
    valid_frames: int,
    rng: np.random.Generator,
    *,
    mode: str = "mixed",
) -> Tuple[List[Tuple[int, int]], np.ndarray, np.ndarray]:
    """Extract realistic sparse anchor spans and structured organ/glottis masks from a 50 Hz trajectory."""
    n = max(2, int(valid_frames))
    # Compute frame-to-frame motion magnitude to bias anchor placement near inflection points & plateaus
    if n >= 4:
        vel = np.linalg.norm(np.diff(kf26_norm[:n, :17], axis=0), axis=-1)
        gvel = np.linalg.norm(np.diff(kf26_norm[:n, 17:], axis=0), axis=-1)
        score = vel + 0.8 * gvel
    else:
        score = np.zeros(max(1, n - 1), dtype=np.float32)

    r = float(rng.random())
    if mode == "phonation" or (mode == "mixed" and r < 0.28):
        # Expressive voice-quality transition mode: sparser spans, lock all 9 source dims + partial tract
        min_step, max_step = 5, 16  # 100..320 ms
        pin_source = True
        keep_prob = float(rng.uniform(0.45, 0.85))
    elif mode == "very_sparse" or (mode == "mixed" and r < 0.45):
        # Long-range sparse keyframe interpolation (160..360 ms spacing)
        min_step, max_step = 8, 18
        pin_source = bool(rng.random() < 0.65)
        keep_prob = float(rng.uniform(0.40, 0.80))
    else:
        # Phonetic segment-like cadence (60..200 ms spacing) with realistic partial organ masks
        min_step, max_step = 3, 10
        pin_source = bool(rng.random() < 0.50)
        keep_prob = float(rng.uniform(0.35, 0.78))

    bounds = [0]
    cur = 0
    while cur < n - min_step:
        step = int(rng.integers(min_step, max_step + 1))
        nxt = min(n, cur + step)
        # Snap boundary slightly toward nearby high-velocity transition if available
        if nxt < n - 1 and score.size >= nxt:
            lo = max(cur + min_step, nxt - 2)
            hi = min(n - 1, nxt + 2)
            if hi > lo:
                nxt = int(lo + np.argmax(score[lo:hi]))
        if nxt <= cur:
            nxt = min(n, cur + min_step)
        bounds.append(nxt)
        cur = nxt
    if bounds[-1] < n:
        if n - bounds[-1] < 2 and len(bounds) >= 2:
            bounds[-1] = n
        else:
            bounds.append(n)

    spans: List[Tuple[int, int]] = [(bounds[i], bounds[i + 1]) for i in range(len(bounds) - 1)]
    k_cnt = len(spans)
    poses = np.empty((k_cnt, KF_OUT_DIM), dtype=np.float32)
    masks = np.zeros((k_cnt, KF_OUT_DIM), dtype=np.float32)

    for k, (a, b) in enumerate(spans):
        # Sample target pose at segment interior (middle 50% mean or center frame)
        mid_a = a + (b - a) // 4
        mid_b = max(mid_a + 1, b - (b - a) // 4)
        pose = kf26_norm[mid_a:mid_b].mean(axis=0).astype(np.float32)
        poses[k] = pose

        m = np.zeros(KF_OUT_DIM, dtype=np.float32)
        # Pick random subset of organ groups (at least 2 oral groups)
        oral_selected = 0
        for g_idx, cols in enumerate(_ORGAN_GROUP_IDXS[:7]):
            if rng.random() < keep_prob:
                m[cols] = 1.0
                oral_selected += 1
        if oral_selected == 0:
            pick = int(rng.integers(0, 4))
            m[_ORGAN_GROUP_IDXS[pick]] = 1.0

        # Always keep VO/PR/RA moderately anchored so silence/voicing stay grounded
        if rng.random() < 0.85:
            m[KF26_INDEX["VO"]] = 1.0
        if pin_source:
            m[17:] = 1.0
        else:
            m[_ORGAN_GROUP_IDXS[7]] = 0.90 if rng.random() < 0.85 else 0.0
            m[_ORGAN_GROUP_IDXS[8]] = 0.35 if rng.random() < 0.60 else 0.0
        masks[k] = m

        # Deliberately corrupt masked-out dims (w==0) to verify zero-leakage invariance!
        zero_dims = m <= 1e-6
        if np.any(zero_dims):
            poses[k, zero_dims] = rng.uniform(-0.9, 0.9, size=int(zero_dims.sum())).astype(np.float32)

    return spans, poses, masks


class Synth180hMaskDataset(Dataset):
    """Stage K1 (and K2 10% mix) dataset reading existing 180h M27 shards with zero re-synthesis."""

    def __init__(
        self,
        corpus_dir: Path,
        *,
        split: str = "train",
        val_ratio: float = 0.02,
        segment_frames: int = 150,  # 3.0 s @ 50 Hz
        max_open_shards: int = 384,
        seed: int = 20261122,
        include_wav: bool = False,
    ) -> None:
        self.corpus_dir = Path(corpus_dir)
        self.split = split
        self.segment_frames = int(segment_frames)
        self.max_open_shards = max(4, int(max_open_shards))
        self.include_wav = bool(include_wav)
        self.rng = np.random.default_rng(seed)

        man_path = self.corpus_dir / "manifest.jsonl"
        if not man_path.is_file():
            raise FileNotFoundError(f"未找到 180h 合成语料清单: {man_path}")
        recs = [json.loads(line) for line in man_path.read_text(encoding="utf-8").splitlines() if line.strip()]
        recs.sort(key=lambda r: int(r["shard_idx"]))
        n_val = max(1, int(round(len(recs) * val_ratio)))
        chosen = recs[-n_val:] if split == "val" else recs[:-n_val]

        self.items: List[Tuple[str, Path, int]] = []
        for rec in chosen:
            fp = self.corpus_dir / rec["file"]
            if not fp.is_file():
                continue
            for i in range(int(rec["num_utts"])):
                self.items.append((rec["file"], fp, i))
        self._cache: OrderedDict[str, Dict[str, np.ndarray]] = OrderedDict()

    def _get_shard(self, key: str, path: Path) -> Dict[str, np.ndarray]:
        if key in self._cache:
            self._cache.move_to_end(key)
            return self._cache[key]
        with np.load(path, allow_pickle=False) as d:
            data = {
                "m27_f16": d["m27_f16"],
                "frame_offsets": d["frame_offsets"],
            }
            if self.include_wav:
                data["audio_i16"] = d["audio_i16"]
                data["audio_offsets"] = d["audio_offsets"]
        self._cache[key] = data
        while len(self._cache) > self.max_open_shards:
            self._cache.popitem(last=False)
        return data

    def __len__(self) -> int:
        return len(self.items)

    def __getitem__(self, idx: int) -> Dict[str, torch.Tensor]:
        skey, path, utt_idx = self.items[idx]
        shard = self._get_shard(skey, path)
        f0_i, f1_i = int(shard["frame_offsets"][utt_idx]), int(shard["frame_offsets"][utt_idx + 1])
        m27_phys = shard["m27_f16"][f0_i:f1_i].astype(np.float32)
        n_total = m27_phys.shape[0]
        seg_f = self.segment_frames

        if n_total >= seg_f:
            start_f = int(self.rng.integers(0, n_total - seg_f + 1)) if (self.split == "train" and n_total > seg_f) else 0
            m27_seg = m27_phys[start_f : start_f + seg_f]
            valid_len = seg_f
        else:
            start_f = 0
            m27_seg = np.repeat(DEFAULT_M27_PAD_ROW[None, :], seg_f, axis=0)
            m27_seg[:n_total] = m27_phys
            valid_len = n_total

        m27_norm = normalize_m27(m27_seg)
        f0_norm = m27_norm[:, F0_IDX].copy()
        kf26_tgt = m27_to_kf26(m27_norm).astype(np.float32)

        valid_mask = np.zeros(seg_f, dtype=np.float32)
        valid_mask[:valid_len] = 1.0

        spans, poses, masks = sample_sparse_anchors_from_trajectory(
            kf26_tgt, valid_len, self.rng, mode="mixed"
        )
        cond, x_base, w_mask, events = build_condition_from_sparse_anchors(
            spans, poses, masks, seg_f, f0_norm
        )

        out = {
            "cond": torch.from_numpy(cond),
            "x_base": torch.from_numpy(x_base),
            "x_target": torch.from_numpy(kf26_tgt),
            "f0_norm": torch.from_numpy(f0_norm),
            "w_mask": torch.from_numpy(w_mask),
            "events": torch.from_numpy(events),
            "valid_mask": torch.from_numpy(valid_mask),
            "has_wav": torch.tensor(False, dtype=torch.bool),
            "wav_16k": torch.zeros(seg_f * WAVLM_HOP_SAMPLES, dtype=torch.float32),
        }
        if self.include_wav and "audio_i16" in shard:
            a0, a1 = int(shard["audio_offsets"][utt_idx]), int(shard["audio_offsets"][utt_idx + 1])
            wav = shard["audio_i16"][a0:a1].astype(np.float32) / 32767.0
            s0 = start_f * WAVLM_HOP_SAMPLES
            s1 = s0 + seg_f * WAVLM_HOP_SAMPLES
            clip = wav[s0:s1]
            buf = np.zeros(seg_f * WAVLM_HOP_SAMPLES, dtype=np.float32)
            buf[: min(len(clip), len(buf))] = clip[: len(buf)]
            out["wav_16k"] = torch.from_numpy(buf)
            out["has_wav"] = torch.tensor(True, dtype=torch.bool)
        return out


class NaturalKFDataset(Dataset):
    """Stage K2/K3 natural-speech dataset reading extracted Stage-4 teacher records (JSONL + NPZ).

    Supports both:
      - Labeled phonetic corpora (TIMIT, Mandarin single-syllable): uses CanonicalPoseBank lookup
        so the model NEVER sees ground-truth contextual tongue/lip frames in its input!
      - Unlabeled expressive corpora (GTSinger, emotion): uses sparse voice-quality anchor masking.
    """

    def __init__(
        self,
        manifest_paths: Sequence[Path],
        pose_bank: CanonicalPoseBank,
        *,
        split: str = "train",
        segment_frames: int = 150,  # 3.0 s @ 50 Hz
        min_cos24: float = 0.60,
        load_wav: bool = True,
        core_jitter_std: float = 0.025,
        soft_jitter_std: float = 0.12,
        seed: int = 20261122,
    ) -> None:
        self.pose_bank = pose_bank
        self.split = split
        self.segment_frames = int(segment_frames)
        self.load_wav = bool(load_wav)
        self.core_jitter_std = float(core_jitter_std) if split == "train" else 0.0
        self.soft_jitter_std = float(soft_jitter_std) if split == "train" else 0.0
        self.rng = np.random.default_rng(seed)

        self.records: List[Dict[str, Any]] = []
        self._m27_cache: OrderedDict[str, np.ndarray] = OrderedDict()
        # Store compact float16 in worker-local RAM (~120 MB for all ~27k natural clips) -> zero disk IO after 1st pass
        self._max_cached_utts = 30000
        for mp in manifest_paths:
            mp = Path(mp)
            if not mp.is_file():
                continue
            for line in mp.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                rec = json.loads(line)
                if rec.get("split", "train") != split:
                    continue
                if float(rec.get("cos24", 1.0)) < min_cos24:
                    continue
                if int(rec.get("n_frames", 0)) < 6:
                    continue
                self.records.append(rec)

    def __len__(self) -> int:
        return len(self.records)

    def _load_wav_slice(self, wav_path: str, start_f: int, seg_f: int) -> Tuple[np.ndarray, bool]:
        seg_s = seg_f * WAVLM_HOP_SAMPLES
        buf = np.zeros(seg_s, dtype=np.float32)
        if not self.load_wav or not wav_path:
            return buf, False
        p = Path(wav_path)
        if not p.is_file():
            return buf, False
        try:
            audio, sr = sf.read(str(p), dtype="float32", always_2d=False)
            if audio.ndim == 2:
                audio = audio.mean(axis=1)
            if sr != SAMPLE_RATE_16K:
                from math import gcd
                from scipy.signal import resample_poly
                g = gcd(int(sr), SAMPLE_RATE_16K)
                audio = resample_poly(audio, SAMPLE_RATE_16K // g, sr // g).astype(np.float32)
            s0 = start_f * WAVLM_HOP_SAMPLES
            clip = audio[s0 : s0 + seg_s]
            n = min(len(clip), seg_s)
            buf[:n] = clip[:n]
            return buf, True
        except Exception:
            return buf, False

    def __getitem__(self, idx: int) -> Dict[str, torch.Tensor]:
        rec = self.records[idx]
        npz_key = str(rec["npz_path"])
        cached = self._m27_cache.get(npz_key)
        if cached is not None:
            m27_phys = cached.astype(np.float32)
        else:
            with np.load(Path(npz_key), allow_pickle=False) as d:
                raw = d["m27_phys"]
            m27_phys = raw.astype(np.float32)
            if len(self._m27_cache) < self._max_cached_utts:
                self._m27_cache[npz_key] = raw.astype(np.float16)

        n_total = m27_phys.shape[0]
        seg_f = self.segment_frames
        if n_total >= seg_f:
            start_f = int(self.rng.integers(0, n_total - seg_f + 1)) if (self.split == "train" and n_total > seg_f) else 0
            m27_seg = m27_phys[start_f : start_f + seg_f]
            valid_len = seg_f
        else:
            start_f = 0
            m27_seg = np.repeat(DEFAULT_M27_PAD_ROW[None, :], seg_f, axis=0)
            m27_seg[:n_total] = m27_phys
            valid_len = n_total

        m27_norm = normalize_m27(m27_seg)
        f0_norm = m27_norm[:, F0_IDX].copy()
        kf26_tgt = m27_to_kf26(m27_norm).astype(np.float32)
        valid_mask = np.zeros(seg_f, dtype=np.float32)
        valid_mask[:valid_len] = 1.0

        raw_segs = rec.get("segments")
        if raw_segs:
            offset_sec = start_f * 0.02
            win_end_sec = offset_sec + valid_len * 0.02
            shifted: List[SegmentEvent] = []
            for s in raw_segs:
                a = max(offset_sec, float(s["start_sec"])) - offset_sec
                b = min(win_end_sec, float(s["end_sec"])) - offset_sec
                if b <= a + 1e-4:
                    continue
                shifted.append(
                    SegmentEvent(
                        start_sec=a,
                        end_sec=b,
                        ipa=str(s["ipa"]),
                        is_sil=bool(s.get("is_sil", False)),
                        is_closure=bool(s.get("is_closure", False)),
                        is_release=bool(s.get("is_release", False)),
                        is_aspiration=bool(s.get("is_aspiration", False)),
                        is_voiced=bool(s.get("is_voiced", True)),
                        phonation_pinned=bool(s.get("phonation_pinned", False)),
                    )
                )

            def _perturb(pose26: np.ndarray, w26: np.ndarray, _seg: SegmentEvent) -> np.ndarray:
                if self.split != "train":
                    return pose26
                out = pose26.copy()
                # Soft/intermediate channels receive stronger perturbation; zero dims are masked out anyway
                soft = (w26 > 1e-6) & (w26 < 0.75)
                if self.soft_jitter_std > 0 and np.any(soft):
                    out[soft] += self.rng.normal(0.0, self.soft_jitter_std, size=int(soft.sum())).astype(np.float32)
                # Core dims get tiny jitter so user manual tweaks remain responsive at inference
                core = w26 >= 0.75
                if self.core_jitter_std > 0 and np.any(core):
                    out[core] += self.rng.normal(0.0, self.core_jitter_std, size=int(core.sum())).astype(np.float32)
                # Deliberately randomize zero-mask dims to assert invariance
                zero = w26 <= 1e-6
                if np.any(zero):
                    out[zero] = self.rng.uniform(-0.9, 0.9, size=int(zero.sum())).astype(np.float32)
                return np.clip(out, -1.0, 1.0)

            def _lookup_with_glottis_pin(seg: SegmentEvent) -> np.ndarray:
                # Oral tract 17 dims ALWAYS come strictly from global CanonicalPoseBank (zero context leakage!)
                p = self.pose_bank.lookup(seg).copy()
                # When a segment explicitly pins a voice-quality regime (e.g. GTSinger falsetto/breathy/pharyngeal),
                # supply the segment's stable interior glottal target (9 source dims only) so the model learns
                # faithful voice-quality tracking without pulling falsetto/breathy back toward modal speech!
                if seg.phonation_pinned and not seg.is_sil:
                    a_f = max(0, int(round(seg.start_sec / 0.02)))
                    b_f = min(valid_len, int(round(seg.end_sec / 0.02)))
                    if b_f > a_f:
                        ia = a_f + (b_f - a_f) // 4
                        ib = max(ia + 1, b_f - (b_f - a_f) // 4)
                        p[17:] = np.median(kf26_tgt[ia:ib, 17:], axis=0).astype(np.float32)
                return p

            cond, x_base, w_mask, events = build_condition_from_segments(
                shifted,
                seg_f,
                f0_norm,
                _lookup_with_glottis_pin,
                pose_perturb_fn=_perturb if self.split == "train" else None,
            )
        else:
            # Expressive unlabeled voice-quality mode (GTSinger / emotion)
            spans, poses, masks = sample_sparse_anchors_from_trajectory(
                kf26_tgt, valid_len, self.rng, mode="phonation"
            )
            cond, x_base, w_mask, events = build_condition_from_sparse_anchors(
                spans, poses, masks, seg_f, f0_norm
            )

        wav_clip, has_wav = self._load_wav_slice(str(rec.get("wav_path", "")), start_f, seg_f)
        return {
            "cond": torch.from_numpy(cond),
            "x_base": torch.from_numpy(x_base),
            "x_target": torch.from_numpy(kf26_tgt),
            "f0_norm": torch.from_numpy(f0_norm),
            "w_mask": torch.from_numpy(w_mask),
            "events": torch.from_numpy(events),
            "valid_mask": torch.from_numpy(valid_mask),
            "has_wav": torch.tensor(has_wav, dtype=torch.bool),
            "wav_16k": torch.from_numpy(wav_clip),
        }


class WeightedMixDataset(Dataset):
    """Stochastic weighted mixture of multiple KF datasets with deterministic epoch length."""

    def __init__(
        self,
        datasets: Sequence[Dataset],
        weights: Sequence[float],
        *,
        virtual_length: int = 20000,
        seed: int = 20261122,
    ) -> None:
        active = [(ds, float(w)) for ds, w in zip(datasets, weights) if len(ds) > 0 and float(w) > 0.0]
        if not active:
            raise ValueError("WeightedMixDataset 至少需要一个非空数据源")
        self.datasets = [a[0] for a in active]
        w_arr = np.array([a[1] for a in active], dtype=np.float64)
        self.probs = w_arr / w_arr.sum()
        self.virtual_length = int(virtual_length)
        self.rng = np.random.default_rng(seed)

    def __len__(self) -> int:
        return self.virtual_length

    def __getitem__(self, _idx: int) -> Dict[str, torch.Tensor]:
        ds_idx = int(self.rng.choice(len(self.datasets), p=self.probs))
        ds = self.datasets[ds_idx]
        item_idx = int(self.rng.integers(0, len(ds)))
        return ds[item_idx]


__all__ = [
    "CanonicalPoseBank",
    "NaturalKFDataset",
    "Synth180hMaskDataset",
    "WeightedMixDataset",
    "sample_sparse_anchors_from_trajectory",
]
