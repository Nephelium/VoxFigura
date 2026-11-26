"""PyTorch Dataset for sharded synthetic R21 vocal-tract trajectories."""
from __future__ import annotations

from collections import OrderedDict
import json
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np
import torch
from torch.utils.data import Dataset, Sampler

from .constants import SAMPLE_RATE_16K, WAVLM_HOP_SAMPLES, normalize_m22


class SynthSegmentDataset(Dataset):
    """按固定帧长切片读取 shard_*.npz 合成语音与 22 维控制轨迹。"""

    def __init__(
        self,
        data_dir: Path,
        *,
        split: str = "train",
        val_ratio: float = 0.05,
        segment_frames: int = 125,  # 2.5 s @ 50 Hz
        max_open_shards: int = 24,
        seed: int = 42,
    ) -> None:
        self.data_dir = Path(data_dir)
        self.segment_frames = int(segment_frames)
        self.segment_samples = self.segment_frames * WAVLM_HOP_SAMPLES
        self.max_open_shards = max(2, int(max_open_shards))
        self.rng = np.random.default_rng(seed)

        manifest_path = self.data_dir / "manifest.jsonl"
        if not manifest_path.is_file():
            raise FileNotFoundError(f"未找到合成清单: {manifest_path}")

        records = [json.loads(line) for line in manifest_path.read_text(encoding="utf-8").splitlines() if line.strip()]
        records.sort(key=lambda r: int(r["shard_idx"]))
        if not records:
            raise ValueError(f"合成清单为空: {manifest_path}")

        if len(records) == 1:
            # 单分片冒烟模式下，同一分片按条目索引切分 train / val
            n_utts = int(records[0]["num_utts"])
            n_val = max(1, int(round(n_utts * val_ratio)))
            if split == "val":
                self.items = [(records[0]["file"], i) for i in range(n_utts - n_val, n_utts)]
            else:
                self.items = [(records[0]["file"], i) for i in range(0, max(1, n_utts - n_val))]
        else:
            n_val_shards = max(1, int(round(len(records) * val_ratio)))
            if split == "val":
                chosen = records[-n_val_shards:]
            else:
                chosen = records[:-n_val_shards]
            self.items = []
            for rec in chosen:
                for i in range(int(rec["num_utts"])):
                    self.items.append((rec["file"], i))

        self._shard_cache: OrderedDict[str, Dict[str, np.ndarray]] = OrderedDict()

    def _get_shard(self, filename: str) -> Dict[str, np.ndarray]:
        if filename in self._shard_cache:
            self._shard_cache.move_to_end(filename)
            return self._shard_cache[filename]
        path = self.data_dir / filename
        with np.load(path, allow_pickle=False) as d:
            data = {
                "audio_i16": d["audio_i16"],
                "m22_f16": d["m22_f16"],
                "audio_offsets": d["audio_offsets"],
                "frame_offsets": d["frame_offsets"],
            }
        self._shard_cache[filename] = data
        while len(self._shard_cache) > self.max_open_shards:
            self._shard_cache.popitem(last=False)
        return data

    def __len__(self) -> int:
        return len(self.items)

    def __getitem__(self, idx: int) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        filename, utt_idx = self.items[idx]
        shard = self._get_shard(filename)
        a0, a1 = int(shard["audio_offsets"][utt_idx]), int(shard["audio_offsets"][utt_idx + 1])
        f0, f1 = int(shard["frame_offsets"][utt_idx]), int(shard["frame_offsets"][utt_idx + 1])

        wav = shard["audio_i16"][a0:a1].astype(np.float32) / 32767.0
        m22_phys = shard["m22_f16"][f0:f1].astype(np.float32)
        n_frames = m22_phys.shape[0]

        seg_f = self.segment_frames
        seg_s = self.segment_samples
        if n_frames >= seg_f:
            start_f = int(self.rng.integers(0, n_frames - seg_f + 1)) if n_frames > seg_f else 0
            wav_seg = wav[start_f * WAVLM_HOP_SAMPLES:(start_f + seg_f) * WAVLM_HOP_SAMPLES]
            m22_seg = m22_phys[start_f:start_f + seg_f]
            mask = np.ones(seg_f, dtype=np.float32)
        else:
            wav_seg = np.zeros(seg_s, dtype=np.float32)
            wav_seg[:len(wav)] = wav
            m22_seg = np.zeros((seg_f, 22), dtype=np.float32)
            m22_seg[:n_frames] = m22_phys
            # padding 区域填充合理默认值以免 log(0)
            m22_seg[n_frames:, 21] = 120.0
            m22_seg[n_frames:, 17] = 0.12
            m22_seg[n_frames:, 18] = 0.05
            mask = np.zeros(seg_f, dtype=np.float32)
            mask[:n_frames] = 1.0

        m22_norm = normalize_m22(m22_seg)
        return (
            torch.from_numpy(wav_seg),
            torch.from_numpy(m22_norm),
            torch.from_numpy(mask),
        )


class ShardGroupedSampler(Sampler[int]):
    """分片分组随机采样器：按分片窗口分块后组内打乱，兼顾随机性与 LRU 分片缓存命中率。"""

    def __init__(
        self,
        dataset: SynthSegmentDataset,
        *,
        group_shards: int = 16,
        seed: int = 42,
    ) -> None:
        self.dataset = dataset
        self.group_shards = max(1, int(group_shards))
        self.seed = int(seed)
        self._epoch = 0

        by_shard: Dict[str, List[int]] = OrderedDict()
        for idx, (fname, _) in enumerate(dataset.items):
            by_shard.setdefault(fname, []).append(idx)
        self._shard_names = list(by_shard.keys())
        self._shard_indices = [np.asarray(by_shard[name], dtype=np.int64) for name in self._shard_names]

    def __len__(self) -> int:
        return len(self.dataset)

    def __iter__(self):
        rng = np.random.default_rng(self.seed + self._epoch * 7919)
        self._epoch += 1

        shard_order = rng.permutation(len(self._shard_indices))
        g = self.group_shards
        for start in range(0, len(shard_order), g):
            chunk = [self._shard_indices[int(s)] for s in shard_order[start:start + g]]
            pooled = np.concatenate(chunk) if len(chunk) > 1 else chunk[0].copy()
            rng.shuffle(pooled)
            for idx in pooled.tolist():
                yield idx
