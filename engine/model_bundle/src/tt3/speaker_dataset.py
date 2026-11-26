"""Multi-corpus speaker-classified dataset & paired utterance sampler for Stage 5 Neural Synthesis."""
from __future__ import annotations

import io
import json
from math import gcd
from pathlib import Path
import queue
import shutil
import tarfile
import threading
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np
from scipy.signal import resample_poly
import soundfile as sf
import torch
from torch.utils.data import Dataset

from .constants import (
    LIBRISPEECH_DIR,
    SAMPLE_RATE_16K,
    TRAIN_ROOT,
    WAVLM_HOP_SAMPLES,
)
from .inference import extract_speech_mono
from .m27_contract import F0_MAX_M27, F0_MIN_M27, normalize_f0_m27
from .pitch import SwiftF0Extractor
from .streaming_corpora import AISHELL3_TAR

VOICEOVER_ROOT = Path(r"C:\Users\13680\Desktop\博士论文\配音音频")
VOICEOVER_SUBDIRS: Tuple[str, ...] = (
    "女1",
    "男1",
    "男2",
    r"线下录音\女1",
    r"线下录音\女2",
    r"线下录音\男1",
    r"线下录音\男2",
)
AUDIO_EXTS = {".wav", ".flac", ".ogg", ".mp3"}

_THREAD_LOCAL = threading.local()


def _get_tar_fh(tar_path: str):
    cache = getattr(_THREAD_LOCAL, "tar_fhs", None)
    if cache is None:
        cache = {}
        _THREAD_LOCAL.tar_fhs = cache
    fh = cache.get(tar_path)
    if fh is None or fh.closed:
        fh = open(tar_path, "rb")
        cache[tar_path] = fh
    return fh


def _read_entry_audio_16k(entry: Dict[str, Any]) -> Optional[np.ndarray]:
    """Decode one indexed audio entry (file or uncompressed tar slice) to mono 16 kHz float32."""
    try:
        if entry.get("src") == "tar":
            fh = _get_tar_fh(str(entry["tar"]))
            fh.seek(int(entry["offset"]))
            raw = fh.read(int(entry["size"]))
            data, sr = sf.read(io.BytesIO(raw), dtype="float32", always_2d=False)
        else:
            data, sr = sf.read(str(entry["path"]), dtype="float32", always_2d=False)
    except Exception:
        return None

    arr = extract_speech_mono(np.asarray(data, dtype=np.float32), int(sr))
    if len(arr) == 0 or not np.isfinite(arr).all():
        return None
    if int(sr) != SAMPLE_RATE_16K:
        g = gcd(int(sr), SAMPLE_RATE_16K)
        arr = resample_poly(arr, SAMPLE_RATE_16K // g, int(sr) // g).astype(np.float32)
    rms = float(np.sqrt(np.mean(arr * arr)))
    peak = float(np.max(np.abs(arr)))
    if rms < 0.0012 or peak < 0.008:
        return None
    if float(np.mean(np.abs(arr) >= 0.99)) > 0.01:
        return None
    return arr.astype(np.float32)


def prepare_librispeech_speaker_subset(
    out_dir: Path = TRAIN_ROOT / "data" / "librispeech_spk_subset",
    *,
    train_clips_per_spk: int = 12,
    val_clips_per_spk: int = 4,
    min_free_gb: float = 25.0,
) -> Path:
    """Optionally extract a compact speaker-balanced English LibriSpeech subset (~251 train + 40 val speakers)."""
    out_dir = Path(out_dir)
    marker = out_dir / ".done.json"
    if marker.is_file():
        return out_dir

    free_gb = shutil.disk_usage(str(TRAIN_ROOT)).free / (1024 ** 3)
    if free_gb < float(min_free_gb):
        print(f"[SpeakerIdx] Skip LibriSpeech subset extract (free={free_gb:.1f} GB < {min_free_gb} GB)", flush=True)
        return out_dir

    out_dir.mkdir(parents=True, exist_ok=True)
    jobs = [
        ("train", LIBRISPEECH_DIR / "train-clean-100.tar.gz", int(train_clips_per_spk)),
        ("val", LIBRISPEECH_DIR / "dev-clean.tar.gz", int(val_clips_per_spk)),
    ]
    counts: Dict[str, Dict[str, int]] = {"train": {}, "val": {}}
    saved = {"train": 0, "val": 0}

    for split_name, tar_path, cap in jobs:
        if not tar_path.is_file():
            continue
        spk_cnt = counts[split_name]
        with tarfile.open(tar_path, mode="r|gz") as tf:
            for member in tf:
                if not member.isfile() or not member.name.lower().endswith(".flac"):
                    continue
                parts = member.name.replace("\\", "/").split("/")
                # LibriSpeech/train-clean-100/<spk>/<chap>/<utt>.flac
                spk = next((p for p in parts if p.isdigit()), None)
                if spk is None:
                    continue
                if spk_cnt.get(spk, 0) >= cap:
                    continue
                fobj = tf.extractfile(member)
                if fobj is None:
                    continue
                raw = fobj.read()
                if len(raw) < 16000:
                    continue
                dst = out_dir / split_name / spk / Path(member.name).name
                dst.parent.mkdir(parents=True, exist_ok=True)
                if not dst.is_file():
                    dst.write_bytes(raw)
                spk_cnt[spk] = spk_cnt.get(spk, 0) + 1
                saved[split_name] += 1

    marker.write_text(
        json.dumps(
            {
                "train_speakers": len(counts["train"]),
                "train_clips": saved["train"],
                "val_speakers": len(counts["val"]),
                "val_clips": saved["val"],
            },
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    print(
        f"[SpeakerIdx] Extracted compact LibriSpeech subset: "
        f"train={len(counts['train'])} spk / {saved['train']} clips, "
        f"val={len(counts['val'])} spk / {saved['val']} clips -> {out_dir}",
        flush=True,
    )
    return out_dir


def _index_aishell3_tar(
    tar_path: Path,
    train_groups: Dict[str, Dict[str, List[Dict[str, Any]]]],
    val_groups: Dict[str, Dict[str, List[Dict[str, Any]]]],
) -> None:
    if not tar_path.is_file():
        return
    tar_str = str(tar_path)
    raw_train: Dict[str, List[Dict[str, Any]]] = {}
    raw_test: Dict[str, List[Dict[str, Any]]] = {}
    with tarfile.open(tar_path, mode="r:") as tf:
        while True:
            member = tf.next()
            if member is None:
                break
            if len(tf.members) > 512:
                tf.members.clear()
            if not member.isfile():
                continue
            norm = member.name.lstrip("./").replace("\\", "/")
            low = norm.lower()
            if not low.endswith(".wav"):
                continue
            parts = norm.split("/")
            # train/wav/<spk>/<utt>.wav or test/wav/<spk>/<utt>.wav
            if len(parts) < 4 or parts[1].lower() != "wav":
                continue
            split = parts[0].lower()
            spk = parts[2]
            entry = {
                "src": "tar",
                "tar": tar_str,
                "offset": int(member.offset_data),
                "size": int(member.size),
                "spk": f"aishell3:{spk}",
                "group": "aishell3",
            }
            if split == "train":
                raw_train.setdefault(spk, []).append(entry)
            elif split == "test":
                raw_test.setdefault(spk, []).append(entry)

    train_spks = train_groups.setdefault("aishell3", {})
    val_spks = val_groups.setdefault("aishell3_test", {})
    for spk, entries in raw_train.items():
        train_spks[f"aishell3:{spk}"] = list(entries)
    for spk, entries in raw_test.items():
        if spk in raw_train:
            # Keep seen AISHELL-3 speakers strictly in train (adds more utts for 25 1-clip train spks)
            train_spks[f"aishell3:{spk}"].extend(entries)
        else:
            # 44 completely unseen speakers stay strictly in held-out val!
            val_spks[f"aishell3_test:{spk}"] = [
                {**e, "spk": f"aishell3_test:{spk}", "group": "aishell3_test"} for e in entries
            ]


def _infer_spk_from_path(root: Path, wav_path: Path, prefix: str) -> str:
    rel_parts = wav_path.relative_to(root).parts
    if prefix == "m4singer":
        for part in rel_parts[:-1]:
            if "#" in part:
                return f"m4:{part.split('#', 1)[0]}"
        if "opencpop" in str(wav_path).lower():
            return "m4:opencpop"
    if len(rel_parts) >= 3 and prefix in ("gtsinger",):
        # Chinese/ZH-Alto-1/Breathy/... -> ZH-Alto-1
        return f"gtsinger:{rel_parts[1]}"
    if len(rel_parts) >= 2:
        return f"{prefix}:{rel_parts[0]}"
    stem = wav_path.stem
    head = stem.split("_")[0].split("-")[0]
    return f"{prefix}:{head}"


def _index_local_dataset_dir(
    root: Path,
    prefix: str,
    group: str,
    dest_groups: Dict[str, Dict[str, List[Dict[str, Any]]]],
) -> None:
    if not root.is_dir():
        return
    manifest = root / "manifest.jsonl"
    if manifest.is_file():
        indexed = 0
        for line in manifest.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except Exception:
                continue
            raw_p = rec.get("path") or rec.get("rel_path") or rec.get("audio_path") or rec.get("file")
            if not raw_p:
                continue
            p = Path(raw_p)
            if not p.is_absolute():
                p = root / p
            if not p.is_file() or p.suffix.lower() not in AUDIO_EXTS:
                continue
            spk_raw = str(rec.get("speaker_id") or rec.get("speaker") or rec.get("singer") or "").strip()
            if spk_raw.lower() in ("unknown", "unk"):
                continue
            spk = f"{prefix}:{spk_raw}" if spk_raw else _infer_spk_from_path(root, p, prefix)
            if spk.lower().endswith(":unknown") or spk.lower().endswith(":unk"):
                continue
            dest_groups.setdefault(group, {}).setdefault(spk, []).append(
                {"src": "file", "path": str(p), "spk": spk, "group": group}
            )
            indexed += 1
        if indexed > 0:
            return

    for p in sorted(root.rglob("*")):
        if not p.is_file() or p.suffix.lower() not in AUDIO_EXTS:
            continue
        low_parts = [pt.lower() for pt in p.parts]
        if any(pt.startswith(".") or pt == "_dl_tmp" or "副本" in pt for pt in low_parts):
            continue
        spk = _infer_spk_from_path(root, p, prefix)
        dest_groups.setdefault(group, {}).setdefault(spk, []).append(
            {"src": "file", "path": str(p), "spk": spk, "group": group}
        )


def _index_voiceover_dirs(dest_groups: Dict[str, Dict[str, List[Dict[str, Any]]]]) -> None:
    if not VOICEOVER_ROOT.is_dir():
        return
    for sub_rel in VOICEOVER_SUBDIRS:
        sub = VOICEOVER_ROOT / sub_rel
        if not sub.is_dir():
            continue
        session_tag = sub_rel.replace("\\", "_")
        for wav in sorted(sub.glob("*.wav")):
            role = wav.stem.split("_")[0] if "_" in wav.stem else "原声"
            # Group by (session_speaker, character_role) so acted personas keep consistent vocal timbre
            spk = f"vo:{session_tag}:{role}"
            dest_groups.setdefault("emotion", {}).setdefault(spk, []).append(
                {"src": "file", "path": str(wav), "spk": spk, "group": "emotion"}
            )


def _filter_min_clips(
    groups: Dict[str, Dict[str, List[Dict[str, Any]]]],
    min_clips: int = 2,
) -> Dict[str, Dict[str, List[Dict[str, Any]]]]:
    out: Dict[str, Dict[str, List[Dict[str, Any]]]] = {}
    for gname, spk_map in groups.items():
        kept = {spk: utts for spk, utts in spk_map.items() if len(utts) >= min_clips}
        if kept:
            out[gname] = kept
    return out


def build_or_load_speaker_index(
    index_path: Path = TRAIN_ROOT / "data" / "speaker_index_m27.json",
    *,
    data_root: Path = TRAIN_ROOT / "data",
    rebuild: bool = False,
    include_voiceover: bool = False,
) -> Dict[str, Any]:
    """Build or load unified multi-corpus speaker-classified utterance index for Stage 5."""
    index_path = Path(index_path)
    if index_path.is_file() and not rebuild:
        return json.loads(index_path.read_text(encoding="utf-8"))

    train_groups: Dict[str, Dict[str, List[Dict[str, Any]]]] = {}
    val_groups: Dict[str, Dict[str, List[Dict[str, Any]]]] = {}

    _index_aishell3_tar(AISHELL3_TAR, train_groups, val_groups)

    ls_sub = Path(data_root) / "librispeech_spk_subset"
    if (ls_sub / "train").is_dir():
        _index_local_dataset_dir(ls_sub / "train", "ls", "librispeech", train_groups)
    if (ls_sub / "val").is_dir():
        _index_local_dataset_dir(ls_sub / "val", "ls_val", "librispeech_val", val_groups)

    _index_local_dataset_dir(Path(data_root) / "emotion_esd", "esd", "emotion", train_groups)
    _index_local_dataset_dir(Path(data_root) / "emotion_expresso", "expresso", "emotion", train_groups)
    if include_voiceover:
        _index_voiceover_dirs(train_groups)

    _index_local_dataset_dir(Path(data_root) / "singing_m4_opencpop", "m4singer", "singing", train_groups)
    _index_local_dataset_dir(Path(data_root) / "singing_vocalset", "vocalset", "singing", train_groups)
    _index_local_dataset_dir(Path(data_root) / "singing_gtsinger_zhen", "gtsinger", "singing", train_groups)

    train_groups = _filter_min_clips(train_groups, min_clips=2)
    val_groups = _filter_min_clips(val_groups, min_clips=2)

    stats = {
        "train": {
            g: {"speakers": len(spks), "clips": sum(len(v) for v in spks.values())}
            for g, spks in train_groups.items()
        },
        "val": {
            g: {"speakers": len(spks), "clips": sum(len(v) for v in spks.values())}
            for g, spks in val_groups.items()
        },
    }
    payload = {"train": train_groups, "val": val_groups, "stats": stats}
    index_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = index_path.with_suffix(".tmp.json")
    tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    tmp.replace(index_path)
    print(f"[SpeakerIdx] Saved speaker index -> {index_path}\n  stats={json.dumps(stats, ensure_ascii=False)}", flush=True)
    return payload


def _slice_fixed(wav: np.ndarray, length_samples: int, rng: np.random.Generator, center: bool = False) -> Tuple[np.ndarray, int]:
    n = len(wav)
    if n >= length_samples:
        if center:
            off = (n - length_samples) // 2
        else:
            off = int(rng.integers(0, n - length_samples + 1)) if n > length_samples else 0
        return np.ascontiguousarray(wav[off : off + length_samples], dtype=np.float32), length_samples
    out = np.zeros(length_samples, dtype=np.float32)
    out[:n] = wav
    return out, n


def build_val_speaker_pairs(
    index_data: Dict[str, Any],
    *,
    cache_path: Path,
    n_pairs: int = 96,
    tgt_frames: int = 100,
    ref_frames: int = 150,
    seed: int = 20261122,
) -> Dict[str, torch.Tensor]:
    """Build or load deterministic held-out unseen-speaker validation pairs for Stage 5."""
    cache_path = Path(cache_path)
    if cache_path.is_file():
        pack = torch.load(cache_path, map_location="cpu", weights_only=True)
        if pack["wav_tgt"].shape[1] == tgt_frames * WAVLM_HOP_SAMPLES:
            return pack

    val_groups = index_data.get("val") or {}
    if not val_groups:
        raise RuntimeError("验证集不包含可用的跨说话人分组")

    rng = np.random.default_rng(seed)
    pitch = SwiftF0Extractor(fmin=F0_MIN_M27, fmax=F0_MAX_M27)
    tgt_samples = tgt_frames * WAVLM_HOP_SAMPLES
    ref_samples = ref_frames * WAVLM_HOP_SAMPLES

    # Flatten (group, spk, utts) evenly across val groups
    per_group: List[List[Tuple[str, List[Dict[str, Any]]]]] = []
    for gname in sorted(val_groups.keys()):
        spks = sorted(val_groups[gname].items(), key=lambda kv: kv[0])
        per_group.append(spks)

    pairs_meta: List[Tuple[str, List[Dict[str, Any]]]] = []
    idx = 0
    while len(pairs_meta) < n_pairs * 2:
        added = False
        for lst in per_group:
            if idx < len(lst):
                pairs_meta.append(lst[idx])
                added = True
        if not added:
            break
        idx += 1

    wav_tgts, wav_refs, f0s, masks, ref_valid_s = [], [], [], [], []
    for spk, utts in pairs_meta:
        if len(wav_tgts) >= n_pairs:
            break
        perm = rng.permutation(len(utts))
        if len(perm) < 2:
            continue
        w_t = _read_entry_audio_16k(utts[int(perm[0])])
        w_r = _read_entry_audio_16k(utts[int(perm[1])])
        if w_t is None or w_r is None:
            continue
        clip_t, valid_t_samp = _slice_fixed(w_t, tgt_samples, rng, center=True)
        clip_r, valid_r_samp = _slice_fixed(w_r, ref_samples, rng, center=True)
        f0_hz, _ = pitch.extract_50hz(clip_t, num_frames=tgt_frames)
        f0_n = normalize_f0_m27(f0_hz).reshape(tgt_frames, 1)
        valid_f = min(tgt_frames, max(1, valid_t_samp // WAVLM_HOP_SAMPLES))
        mask = np.zeros(tgt_frames, dtype=np.float32)
        mask[:valid_f] = 1.0

        wav_tgts.append(clip_t)
        wav_refs.append(clip_r)
        f0s.append(f0_n)
        masks.append(mask)
        ref_valid_s.append(int(valid_r_samp))

    if not wav_tgts:
        raise RuntimeError("未能构造出有效的未见说话人验证样本对")

    pack = {
        "wav_tgt": torch.from_numpy(np.stack(wav_tgts, axis=0)),
        "wav_ref": torch.from_numpy(np.stack(wav_refs, axis=0)),
        "f0_norm": torch.from_numpy(np.stack(f0s, axis=0)),
        "mask": torch.from_numpy(np.stack(masks, axis=0)),
        "ref_valid_samples": torch.tensor(ref_valid_s, dtype=torch.long),
    }
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = cache_path.with_suffix(".tmp.pt")
    torch.save(pack, tmp)
    tmp.replace(cache_path)
    print(f"[SpeakerIdx] Cached {len(wav_tgts)} unseen-speaker val pairs -> {cache_path}", flush=True)
    return pack


class SpeakerPairDataset(Dataset):
    """Deterministic indexed Dataset wrapper for speaker-paired utterances (useful for smoke tests & val)."""

    def __init__(
        self,
        index_data: Dict[str, Any],
        *,
        split: str = "train",
        tgt_frames: int = 100,
        ref_frames: int = 150,
        seed: int = 20261122,
    ) -> None:
        self.tgt_frames = int(tgt_frames)
        self.ref_frames = int(ref_frames)
        self.tgt_samples = self.tgt_frames * WAVLM_HOP_SAMPLES
        self.ref_samples = self.ref_frames * WAVLM_HOP_SAMPLES
        self.rng = np.random.default_rng(seed)
        self.pitch = SwiftF0Extractor(fmin=F0_MIN_M27, fmax=F0_MAX_M27)

        groups = index_data.get(split) or {}
        self.speakers: List[Tuple[str, str, List[Dict[str, Any]]]] = []
        for gname, spk_map in sorted(groups.items()):
            for spk, utts in sorted(spk_map.items()):
                if len(utts) >= 2:
                    self.speakers.append((gname, spk, utts))

    def __len__(self) -> int:
        return len(self.speakers)

    def __getitem__(self, idx: int) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
        _, _, utts = self.speakers[idx % len(self.speakers)]
        for _ in range(8):
            i, j = self.rng.choice(len(utts), size=2, replace=False)
            w_t = _read_entry_audio_16k(utts[int(i)])
            w_r = _read_entry_audio_16k(utts[int(j)])
            if w_t is None or w_r is None:
                continue
            clip_t, valid_t_samp = _slice_fixed(w_t, self.tgt_samples, self.rng)
            clip_r, valid_r_samp = _slice_fixed(w_r, self.ref_samples, self.rng)
            f0_hz, _ = self.pitch.extract_50hz(clip_t, num_frames=self.tgt_frames)
            f0_n = normalize_f0_m27(f0_hz).reshape(self.tgt_frames, 1)
            valid_f = min(self.tgt_frames, max(1, valid_t_samp // WAVLM_HOP_SAMPLES))
            mask = np.zeros(self.tgt_frames, dtype=np.float32)
            mask[:valid_f] = 1.0
            return (
                torch.from_numpy(clip_t),
                torch.from_numpy(clip_r),
                torch.from_numpy(f0_n),
                torch.from_numpy(mask),
                torch.tensor(valid_r_samp, dtype=torch.long),
            )
        raise RuntimeError("SpeakerPairDataset failed to load valid pair after retries")


class SpeakerPairPool:
    """Multi-threaded asynchronous speaker-paired sampler for Stage 5 Neural Synthesis training."""

    def __init__(
        self,
        index_data: Dict[str, Any],
        *,
        group_weights: Optional[Dict[str, float]] = None,
        synth_glottis_dir: Optional[Path] = TRAIN_ROOT / "data" / "synth_full_glottis_180h",
        tgt_frames: int = 100,
        ref_frames: int = 150,
        buffer_capacity: int = 96,
        singing_f0_max_p95: float = 550.0,
        num_workers: int = 2,
        seed: int = 20261122,
    ) -> None:
        self.train_groups = index_data.get("train") or {}
        if not self.train_groups:
            raise RuntimeError("speaker index train split 为空")

        self.phonation_shards: List[Path] = (
            sorted(Path(synth_glottis_dir).glob("shard_*.npz"))
            if (synth_glottis_dir is not None and Path(synth_glottis_dir).is_dir())
            else []
        )

        default_w = {
            "aishell3": 0.30,
            "librispeech": 0.20,
            "emotion": 0.20,
            "singing": 0.18,
            "phonation_180h": 0.12,
        }
        raw_w = dict(group_weights or default_w)
        self.group_names = [g for g in self.train_groups.keys() if raw_w.get(g, 0.0) > 0.0]
        if self.phonation_shards and raw_w.get("phonation_180h", 0.0) > 0.0:
            self.group_names.append("phonation_180h")

        if not self.group_names:
            self.group_names = sorted(self.train_groups.keys())
            probs = np.ones(len(self.group_names), dtype=np.float64)
        else:
            probs = np.array([raw_w[g] for g in self.group_names], dtype=np.float64)
        self.group_probs = probs / probs.sum()

        self.spk_lists: Dict[str, List[List[Dict[str, Any]]]] = {
            g: [utts for utts in self.train_groups[g].values() if len(utts) >= 2]
            for g in self.group_names
            if g in self.train_groups
        }
        self.tgt_frames = int(tgt_frames)
        self.ref_frames = int(ref_frames)
        self.tgt_samples = self.tgt_frames * WAVLM_HOP_SAMPLES
        self.ref_samples = self.ref_frames * WAVLM_HOP_SAMPLES
        self.singing_f0_max_p95 = float(singing_f0_max_p95)
        self.num_workers = max(1, int(num_workers))
        self.seed = int(seed)

        self._queue: queue.Queue = queue.Queue(maxsize=max(16, int(buffer_capacity)))
        self._stop = threading.Event()
        self._threads: List[threading.Thread] = []
        self._error: Optional[BaseException] = None
        self.stats = {g: 0 for g in self.group_names}
        self.stats["skipped_high_f0"] = 0
        self._stats_lock = threading.Lock()

    def _load_phonation_shard(self, rng: np.random.Generator) -> Optional[Dict[str, Any]]:
        if not self.phonation_shards:
            return None
        sp = self.phonation_shards[int(rng.integers(0, len(self.phonation_shards)))]
        try:
            with np.load(sp, allow_pickle=False) as d:
                return {
                    "audio_i16": np.array(d["audio_i16"], copy=True),
                    "audio_offsets": np.array(d["audio_offsets"], copy=True),
                    "regime_tags": np.array(d["regime_tags"], copy=True),
                    "uses": 12,
                }
        except Exception:
            return None

    def _worker(self, worker_id: int) -> None:
        rng = np.random.default_rng(self.seed + worker_id * 1009)
        pitch = SwiftF0Extractor(fmin=F0_MIN_M27, fmax=F0_MAX_M27)
        shard_cache: Optional[Dict[str, Any]] = None
        try:
            while not self._stop.is_set():
                g = str(rng.choice(self.group_names, p=self.group_probs))
                if g == "phonation_180h":
                    if shard_cache is None or shard_cache["uses"] <= 0:
                        shard_cache = self._load_phonation_shard(rng)
                    if shard_cache is None:
                        continue
                    shard_cache["uses"] -= 1
                    offs = shard_cache["audio_offsets"]
                    tags = shard_cache["regime_tags"]
                    n_clips = len(offs) - 1
                    if n_clips < 2:
                        shard_cache = None
                        continue
                    i = int(rng.integers(0, n_clips))
                    diff_idx = np.flatnonzero(tags[:n_clips] != tags[i])
                    if len(diff_idx) > 0:
                        j = int(diff_idx[int(rng.integers(0, len(diff_idx)))])
                    else:
                        j = int((i + 1 + rng.integers(0, n_clips - 1)) % n_clips)
                    pcm = shard_cache["audio_i16"]
                    w_t = pcm[int(offs[i]) : int(offs[i + 1])].astype(np.float32) / 32768.0
                    w_r = pcm[int(offs[j]) : int(offs[j + 1])].astype(np.float32) / 32768.0
                    if (
                        len(w_t) < 3200
                        or len(w_r) < 3200
                        or not np.isfinite(w_t).all()
                        or not np.isfinite(w_r).all()
                        or float(np.sqrt(np.mean(w_t * w_t))) < 0.0005
                        or float(np.sqrt(np.mean(w_r * w_r))) < 0.0005
                    ):
                        continue
                else:
                    spks = self.spk_lists[g]
                    utts = spks[int(rng.integers(0, len(spks)))]
                    i, j = rng.choice(len(utts), size=2, replace=False)
                    w_t = _read_entry_audio_16k(utts[int(i)])
                    w_r = _read_entry_audio_16k(utts[int(j)])
                    if w_t is None or w_r is None:
                        continue

                clip_t, valid_t_samp = _slice_fixed(w_t, self.tgt_samples, rng)
                clip_r, valid_r_samp = _slice_fixed(w_r, self.ref_samples, rng)
                f0_hz, voiced = pitch.extract_50hz(clip_t, num_frames=self.tgt_frames)
                if g == "singing" and self.singing_f0_max_p95 > 0.0 and bool(np.any(voiced)):
                    if float(np.percentile(f0_hz[voiced], 95)) > self.singing_f0_max_p95:
                        with self._stats_lock:
                            self.stats["skipped_high_f0"] += 1
                        continue

                f0_n = normalize_f0_m27(f0_hz).reshape(self.tgt_frames, 1)
                valid_f = min(self.tgt_frames, max(1, valid_t_samp // WAVLM_HOP_SAMPLES))
                mask = np.zeros(self.tgt_frames, dtype=np.float32)
                mask[:valid_f] = 1.0

                with self._stats_lock:
                    self.stats[g] += 1

                item = (clip_t, clip_r, f0_n, mask, int(valid_r_samp))
                while not self._stop.is_set():
                    try:
                        self._queue.put(item, timeout=0.2)
                        break
                    except queue.Full:
                        continue
        except BaseException as exc:
            self._error = exc

    def start(self) -> None:
        if self._threads:
            return
        self._stop.clear()
        for wid in range(self.num_workers):
            th = threading.Thread(target=self._worker, args=(wid,), daemon=True)
            th.start()
            self._threads.append(th)

    def stop(self) -> None:
        self._stop.set()
        for th in self._threads:
            th.join(timeout=2.0)
        self._threads.clear()

    def next_batch(self, batch_size: int) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
        self.start()
        tgts, refs, f0s, masks, rv_samps = [], [], [], [], []
        for _ in range(batch_size):
            if self._error is not None:
                raise RuntimeError(f"SpeakerPairPool worker error: {self._error}") from self._error
            w_t, w_r, f0_n, m, rv = self._queue.get()
            tgts.append(w_t)
            refs.append(w_r)
            f0s.append(f0_n)
            masks.append(m)
            rv_samps.append(rv)
        return (
            torch.from_numpy(np.stack(tgts, axis=0)),
            torch.from_numpy(np.stack(refs, axis=0)),
            torch.from_numpy(np.stack(f0s, axis=0)),
            torch.from_numpy(np.stack(masks, axis=0)),
            torch.tensor(rv_samps, dtype=torch.long),
        )
