"""Sharded PyTorch Dataset for full-native 27-dim R21 corpus with optional masked legacy 90h mixing."""
from __future__ import annotations

from collections import OrderedDict
import json
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import torch
from torch.utils.data import Dataset, Sampler

from .constants import WAVLM_HOP_SAMPLES
from .m27_contract import (
    DEFAULT_M27_PAD_ROW,
    LEGACY_GLOTTIS8_MASK,
    NATIVE_GLOTTIS8_MASK,
    normalize_m27,
    promote_m22_to_m27_f32,
)


class M27SegmentDataset(Dataset):
    """Load fixed-length 50 Hz segments from native m27 shards (+ optional legacy m22 shards on train).

    Returns per item:
        wav_seg       : (T * 320,) float32
        m27_norm      : (T, 27) float32 in [-1, 1]
        valid_mask    : (T,) float32 (1=valid, 0=pad)
        glottis8_mask : (8,) float32 per-dim supervision weight for [XB, XT, CA, LAG, RA, PS, FL, SHIM]
        is_native_m27 : scalar bool tensor (True for synth_full_glottis_180h, False for legacy synth_100h)
    """

    def __init__(
        self,
        primary_dir: Path,
        *,
        legacy_dir: Optional[Path] = None,
        split: str = "train",
        val_ratio: float = 0.02,
        segment_frames: int = 125,  # 2.5 s @ 50 Hz
        max_open_shards: int = 32,
        seed: int = 42,
    ) -> None:
        self.primary_dir = Path(primary_dir)
        self.legacy_dir = Path(legacy_dir) if legacy_dir is not None else None
        self.split = split
        self.segment_frames = int(segment_frames)
        self.segment_samples = self.segment_frames * WAVLM_HOP_SAMPLES
        self.max_open_shards = max(4, int(max_open_shards))
        self.rng = np.random.default_rng(seed)

        # Each item: (shard_key, full_path, utt_idx, is_native)
        self.items: List[Tuple[str, Path, int, bool]] = []
        self.n_native_items = 0
        self.n_legacy_items = 0

        prim_man = self.primary_dir / "manifest.jsonl"
        if not prim_man.is_file():
            raise FileNotFoundError(f"未找到 27 维合成清单: {prim_man}")
        prim_recs = [
            json.loads(line)
            for line in prim_man.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        prim_recs.sort(key=lambda r: int(r["shard_idx"]))
        if not prim_recs:
            raise ValueError(f"27 维合成清单为空: {prim_man}")

        if len(prim_recs) == 1:
            n_utts = int(prim_recs[0]["num_utts"])
            n_val = max(1, int(round(n_utts * val_ratio)))
            utt_range = range(n_utts - n_val, n_utts) if split == "val" else range(0, max(1, n_utts - n_val))
            fp = self.primary_dir / prim_recs[0]["file"]
            skey = f"m27:{prim_recs[0]['file']}"
            for i in utt_range:
                self.items.append((skey, fp, i, True))
        else:
            n_val_shards = max(1, int(round(len(prim_recs) * val_ratio)))
            chosen = prim_recs[-n_val_shards:] if split == "val" else prim_recs[:-n_val_shards]
            for rec in chosen:
                fp = self.primary_dir / rec["file"]
                if not fp.is_file():
                    continue
                skey = f"m27:{rec['file']}"
                for i in range(int(rec["num_utts"])):
                    self.items.append((skey, fp, i, True))
        self.n_native_items = len(self.items)

        # Legacy 90h modal corpus is ONLY added to train split (val stays 100% pure multi-phonation m27!)
        if split == "train" and self.legacy_dir is not None:
            leg_man = self.legacy_dir / "manifest.jsonl"
            if leg_man.is_file():
                leg_recs = [
                    json.loads(line)
                    for line in leg_man.read_text(encoding="utf-8").splitlines()
                    if line.strip()
                ]
                leg_recs.sort(key=lambda r: int(r["shard_idx"]))
                for rec in leg_recs:
                    fp = self.legacy_dir / rec["file"]
                    if not fp.is_file():
                        continue
                    skey = f"leg:{rec['file']}"
                    for i in range(int(rec["num_utts"])):
                        self.items.append((skey, fp, i, False))
                self.n_legacy_items = len(self.items) - self.n_native_items

        self._shard_cache: OrderedDict[str, Dict[str, np.ndarray]] = OrderedDict()

    def _get_shard(self, skey: str, path: Path, is_native: bool) -> Dict[str, np.ndarray]:
        if skey in self._shard_cache:
            self._shard_cache.move_to_end(skey)
            return self._shard_cache[skey]
        with np.load(path, allow_pickle=False) as d:
            ctrl_key = "m27_f16" if is_native else "m22_f16"
            data = {
                "audio_i16": d["audio_i16"],
                "ctrl_f16": d[ctrl_key],
                "audio_offsets": d["audio_offsets"],
                "frame_offsets": d["frame_offsets"],
            }
        self._shard_cache[skey] = data
        while len(self._shard_cache) > self.max_open_shards:
            self._shard_cache.popitem(last=False)
        return data

    def __len__(self) -> int:
        return len(self.items)

    def __getitem__(
        self,
        idx: int,
    ) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
        skey, path, utt_idx, is_native = self.items[idx]
        shard = self._get_shard(skey, path, is_native)
        a0, a1 = int(shard["audio_offsets"][utt_idx]), int(shard["audio_offsets"][utt_idx + 1])
        f0, f1 = int(shard["frame_offsets"][utt_idx]), int(shard["frame_offsets"][utt_idx + 1])

        wav = shard["audio_i16"][a0:a1].astype(np.float32) / 32767.0
        raw_ctrl = shard["ctrl_f16"][f0:f1].astype(np.float32)
        m27_phys = raw_ctrl if is_native else promote_m22_to_m27_f32(raw_ctrl)
        n_frames = m27_phys.shape[0]

        seg_f = self.segment_frames
        seg_s = self.segment_samples
        if n_frames >= seg_f:
            start_f = int(self.rng.integers(0, n_frames - seg_f + 1)) if n_frames > seg_f else 0
            wav_seg = wav[start_f * WAVLM_HOP_SAMPLES : (start_f + seg_f) * WAVLM_HOP_SAMPLES]
            m27_seg = m27_phys[start_f : start_f + seg_f]
            mask = np.ones(seg_f, dtype=np.float32)
        else:
            wav_seg = np.zeros(seg_s, dtype=np.float32)
            wav_seg[: len(wav)] = wav
            m27_seg = np.repeat(DEFAULT_M27_PAD_ROW[None, :], seg_f, axis=0)
            m27_seg[:n_frames] = m27_phys
            mask = np.zeros(seg_f, dtype=np.float32)
            mask[:n_frames] = 1.0

        m27_norm = normalize_m27(m27_seg)
        g8_mask = NATIVE_GLOTTIS8_MASK if is_native else LEGACY_GLOTTIS8_MASK
        return (
            torch.from_numpy(wav_seg),
            torch.from_numpy(m27_norm),
            torch.from_numpy(mask),
            torch.from_numpy(g8_mask.copy()),
            torch.tensor(is_native, dtype=torch.bool),
        )


class M27ShardGroupedSampler(Sampler[int]):
    """Shard-windowed random sampler preserving near-100% LRU hit rate while mixing shards cleanly."""

    def __init__(
        self,
        dataset: M27SegmentDataset,
        *,
        group_shards: int = 16,
        seed: int = 42,
    ) -> None:
        self.dataset = dataset
        self.group_shards = max(1, int(group_shards))
        self.seed = int(seed)
        self._epoch = 0

        by_shard: Dict[str, List[int]] = OrderedDict()
        for idx, (skey, _, _, _) in enumerate(dataset.items):
            by_shard.setdefault(skey, []).append(idx)
        self._shard_indices = [np.asarray(v, dtype=np.int64) for v in by_shard.values()]

    def __len__(self) -> int:
        return len(self.dataset)

    def __iter__(self):
        rng = np.random.default_rng(self.seed + self._epoch * 7919)
        self._epoch += 1

        order = rng.permutation(len(self._shard_indices))
        g = self.group_shards
        for start in range(0, len(order), g):
            chunk = [self._shard_indices[int(s)] for s in order[start : start + g]]
            pooled = np.concatenate(chunk) if len(chunk) > 1 else chunk[0].copy()
            rng.shuffle(pooled)
            for idx in pooled.tolist():
                yield idx
