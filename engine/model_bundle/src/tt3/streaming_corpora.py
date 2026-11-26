"""Zero-extraction streaming readers for LibriSpeech, KeSpeech, and single-syllable corpora."""
from __future__ import annotations

from collections import deque
import io
from math import gcd
from pathlib import Path
import queue
import tarfile
import threading
from typing import Dict, Iterator, List, Optional, Tuple

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly
import torch

from .constants import (
    KESPEECH_SPLITS_DIR,
    LIBRISPEECH_DIR,
    SAMPLE_RATE_16K,
    SYLLABLE_DIR,
    WAVLM_HOP_SAMPLES,
    normalize_f0,
)
from .inference import extract_speech_mono
from .pitch import SwiftF0Extractor


class MultiPartRawStream(io.RawIOBase):
    """把分卷压缩文件（如 KeSpeech.tar.gz.aa..ai）无缝拼接为单个只读字节流。"""

    def __init__(self, paths: List[Path]) -> None:
        if not paths:
            raise FileNotFoundError("未找到分卷文件列表")
        self._paths = [Path(p) for p in paths]
        self._idx = 0
        self._fh = open(self._paths[0], "rb")

    def readable(self) -> bool:
        return True

    def readinto(self, b) -> int:
        while self._fh is not None:
            n = self._fh.readinto(b)
            if n:
                return n
            self._fh.close()
            self._idx += 1
            if self._idx >= len(self._paths):
                self._fh = None
                return 0
            self._fh = open(self._paths[self._idx], "rb")
        return 0

    def close(self) -> None:
        if self._fh is not None:
            self._fh.close()
            self._fh = None
        super().close()


def _decode_audio_bytes(raw: bytes, target_sr: int = SAMPLE_RATE_16K) -> Optional[np.ndarray]:
    """在内存中把 WAV/FLAC 解码为 16 kHz 单声道 float32 波形（自动剥离双声道 EGG 信号）。"""
    try:
        audio, sr = sf.read(io.BytesIO(raw), dtype="float32", always_2d=False)
    except Exception:
        return None
    audio = extract_speech_mono(audio, int(sr))
    if not np.isfinite(audio).all() or len(audio) == 0:
        return None
    if sr != target_sr:
        common = gcd(int(sr), int(target_sr))
        audio = resample_poly(audio, target_sr // common, sr // common).astype(np.float32)
    return audio.astype(np.float32)


_AUDIO_DIR_EXTS = (".wav", ".flac", ".ogg")


def iter_audio_dirs(
    dirs: List[Path],
    *,
    min_sec: float = 1.0,
    max_sec: float = 45.0,
    seed: int = 20261122,
    recursive: bool = False,
) -> Iterator[Tuple[str, np.ndarray]]:
    """只读遍历本地切分音频目录（自动剥离双声道 EGG 通道、重采样至 16 kHz、每轮随机打乱）。"""
    files: List[Path] = []
    for raw_dir in dirs:
        d = Path(raw_dir)
        if not d.is_dir():
            continue
        it = d.rglob("*") if recursive else d.iterdir()
        for p in it:
            if not p.is_file() or p.suffix.lower() not in _AUDIO_DIR_EXTS:
                continue
            parts_low = [part.lower() for part in p.parts]
            if any(part.startswith(".") or "副本" in part for part in parts_low):
                continue
            files.append(p)
    files = sorted(set(files))
    if not files:
        raise FileNotFoundError(f"本地音频目录未找到可用音频: {[str(d) for d in dirs]}")

    rng = np.random.default_rng(seed)
    min_samples = int(round(min_sec * SAMPLE_RATE_16K))
    max_samples = int(round(max_sec * SAMPLE_RATE_16K))
    order = rng.permutation(len(files))
    for idx in order:
        p = files[int(idx)]
        try:
            data, sr = sf.read(str(p), dtype="float32", always_2d=False)
        except Exception:
            continue
        audio = extract_speech_mono(data, int(sr))
        if not np.isfinite(audio).all() or len(audio) == 0:
            continue
        if int(sr) != SAMPLE_RATE_16K:
            common = gcd(int(sr), SAMPLE_RATE_16K)
            audio = resample_poly(audio, SAMPLE_RATE_16K // common, int(sr) // common).astype(np.float32)
        if len(audio) < min_samples or len(audio) > max_samples:
            continue
        rms = float(np.sqrt(np.mean(audio * audio)))
        peak = float(np.max(np.abs(audio)))
        if rms < 0.0012 or peak < 0.008:
            continue
        if float(np.mean(np.abs(audio) >= 0.99)) > 0.01:
            continue
        yield f"{p.parent.name}/{p.name}", audio.astype(np.float32)


def _valid_speech_clip(audio: np.ndarray, min_samples: int) -> bool:
    if len(audio) < min_samples:
        return False
    rms = float(np.sqrt(np.mean(audio * audio)))
    peak = float(np.max(np.abs(audio)))
    if rms < 0.002 or peak < 0.01:
        return False

    # 严重爆麦削波过滤（超过 0.5% 采样点接近满幅度）
    if float(np.mean(np.abs(audio) >= 0.99)) > 0.005:
        return False

    # 轻量级 20ms 短时能量动态范围过滤：拦截强背景噪音与持续嗡鸣
    hop = WAVLM_HOP_SAMPLES  # 320 samples @ 16 kHz (20 ms)
    n_frames = len(audio) // hop
    if n_frames >= 10:
        frames = audio[:n_frames * hop].reshape(n_frames, hop)
        frame_rms = np.sqrt(np.mean(frames * frames, axis=1))
        noise_floor = float(np.percentile(frame_rms, 5))
        speech_level = float(np.percentile(frame_rms, 95))
        snr_proxy_db = 20.0 * float(np.log10((speech_level + 1e-8) / (noise_floor + 1e-8)))
        if snr_proxy_db < 10.0:
            return False
        if noise_floor > 0.02 and snr_proxy_db < 18.0:
            return False

    return True


def iter_librispeech_tar(
    tar_path: Path = LIBRISPEECH_DIR / "train-clean-100.tar.gz",
    *,
    min_sec: float = 1.2,
) -> Iterator[Tuple[str, np.ndarray]]:
    """流式遍历 LibriSpeech .tar.gz，零落盘产出 (utterance_id, wav_16k)。"""
    min_samples = int(round(min_sec * SAMPLE_RATE_16K))
    with tarfile.open(tar_path, mode="r|gz") as tf:
        for member in tf:
            if not member.isfile() or not member.name.lower().endswith((".flac", ".wav")):
                continue
            fobj = tf.extractfile(member)
            if fobj is None:
                continue
            audio = _decode_audio_bytes(fobj.read())
            if audio is not None and _valid_speech_clip(audio, min_samples):
                yield member.name, audio


AISHELL3_TAR = Path(r"F:\data_aishell3.tar")


def iter_aishell3_tar(
    tar_path: Path = AISHELL3_TAR,
    *,
    split: str = "train",
    min_sec: float = 1.2,
) -> Iterator[Tuple[str, np.ndarray]]:
    """流式遍历未压缩 AISHELL-3 .tar（仅取指定 split 如 train/wav/，保留 test/wav/ 作测试集）。"""
    tar_path = Path(tar_path)
    if not tar_path.is_file():
        raise FileNotFoundError(f"未找到 AISHELL-3 归档: {tar_path}")
    min_samples = int(round(min_sec * SAMPLE_RATE_16K))
    prefix = f"{split}/wav/".lower() if split else ""
    with tarfile.open(tar_path, mode="r:") as tf:
        while True:
            member = tf.next()
            if member is None:
                break
            if len(tf.members) > 512:
                tf.members.clear()
            norm_name = member.name.lstrip("./").replace("\\", "/").lower()
            if not member.isfile() or not norm_name.endswith(".wav"):
                continue
            if prefix and not norm_name.startswith(prefix):
                continue
            fobj = tf.extractfile(member)
            if fobj is None:
                continue
            audio = _decode_audio_bytes(fobj.read())
            if audio is not None and _valid_speech_clip(audio, min_samples):
                yield member.name, audio


def iter_kespeech_splits(
    splits_dir: Path = KESPEECH_SPLITS_DIR,
    *,
    min_sec: float = 1.2,
) -> Iterator[Tuple[str, np.ndarray]]:
    """流式遍历 KeSpeech.tar.gz.aa..ai 分卷，零解压产出 (utterance_id, wav_16k)。"""
    splits = sorted(Path(splits_dir).glob("KeSpeech.tar.gz.*"))
    if not splits:
        raise FileNotFoundError(f"未找到 KeSpeech 分卷: {splits_dir}")
    min_samples = int(round(min_sec * SAMPLE_RATE_16K))
    with io.BufferedReader(MultiPartRawStream(splits), buffer_size=4 * 1024 * 1024) as stream:
        with tarfile.open(fileobj=stream, mode="r|gz") as tf:
            for member in tf:
                if not member.isfile() or not member.name.lower().endswith((".wav", ".flac")):
                    continue
                fobj = tf.extractfile(member)
                if fobj is None:
                    continue
                audio = _decode_audio_bytes(fobj.read())
                if audio is not None and _valid_speech_clip(audio, min_samples):
                    yield member.name, audio


class SyllableStitchStream:
    """只读索引单音节语音库，在线随机拼接 4–8 条单音节构成带停顿连读短串。"""

    def __init__(self, root: Path = SYLLABLE_DIR, seed: int = 2026) -> None:
        self.root = Path(root)
        self.rng = np.random.default_rng(seed)
        self.files: List[Path] = []
        for tone in ("tone1", "tone2", "tone3", "tone4"):
            sub = self.root / tone
            if sub.is_dir():
                self.files.extend(sorted(sub.glob("*.wav")))
        if not self.files:
            raise FileNotFoundError(f"单音节目录未找到 wav 文件: {self.root}")

    def sample_utterance(self, target_sec: float = 2.5) -> Tuple[str, np.ndarray]:
        target_len = int(round(target_sec * SAMPLE_RATE_16K))
        parts: List[np.ndarray] = []
        total = 0
        fade_len = 48  # 3 ms @ 16 kHz
        while total < target_len:
            p = self.files[int(self.rng.integers(0, len(self.files)))]
            try:
                audio, sr = sf.read(str(p), dtype="float32", always_2d=False)
            except Exception:
                continue
            if audio.ndim == 2:
                audio = audio.mean(axis=1)
            if sr != SAMPLE_RATE_16K:
                common = gcd(int(sr), SAMPLE_RATE_16K)
                audio = resample_poly(audio, SAMPLE_RATE_16K // common, sr // common).astype(np.float32)
            if len(audio) < 800:
                continue
            # 轻柔 3 ms 边沿渐变防止拼接爆音，并按均方根归一避免各条响度跳变过大
            rms = float(np.sqrt(np.mean(audio * audio)))
            if rms > 1e-4:
                audio = audio * (0.06 / rms)
            audio = np.clip(audio, -0.95, 0.95).astype(np.float32)
            fl = min(fade_len, len(audio) // 4)
            if fl > 0:
                ramp = np.linspace(0.0, 1.0, fl, dtype=np.float32)
                audio[:fl] *= ramp
                audio[-fl:] *= ramp[::-1]
            parts.append(audio)
            gap = np.zeros(int(self.rng.integers(0, int(0.08 * SAMPLE_RATE_16K) + 1)), dtype=np.float32)
            parts.append(gap)
            total += len(audio) + len(gap)
        merged = np.concatenate(parts)[:target_len]
        return "syllable_stitch", merged


class StreamingNaturalPool:
    """后台多源流式解压 + 环形缓存 + SwiftF0 提取的混合自然语音供数器。"""

    def __init__(
        self,
        *,
        segment_frames: int = 125,  # 2.5 s @ 50 Hz
        mix_weights: Dict[str, float] | None = None,
        max_hours: float = 300.0,
        buffer_capacity: int = 128,
        shuffle_window: int = 128,
        seed: int = 20261119,
        fmin: Optional[float] = None,
        fmax: Optional[float] = None,
        f0_normalizer=None,
        emotion_dirs: Optional[List[Path]] = None,
        singing_dirs: Optional[List[Path]] = None,
        singing_f0_max_p95: float = 550.0,
    ) -> None:
        self.segment_frames = int(segment_frames)
        self.segment_samples = self.segment_frames * WAVLM_HOP_SAMPLES
        self.weights = dict(mix_weights or {"kespeech": 0.55, "librispeech": 0.35, "syllable": 0.10})
        self.emotion_dirs = [Path(d) for d in (emotion_dirs or []) if Path(d).is_dir()]
        self.singing_dirs = [Path(d) for d in (singing_dirs or []) if Path(d).is_dir()]
        self.singing_f0_max_p95 = float(singing_f0_max_p95)
        if not self.emotion_dirs:
            self.weights["emotion"] = 0.0
        if not self.singing_dirs:
            self.weights["singing"] = 0.0
        self.max_seconds = float(max_hours) * 3600.0
        self._base_seed = int(seed)
        self.rng = np.random.default_rng(seed)

        if fmin is not None and fmax is not None:
            self.pitch_extractor = SwiftF0Extractor(fmin=float(fmin), fmax=float(fmax))
        else:
            self.pitch_extractor = SwiftF0Extractor()
        self._f0_normalizer = f0_normalizer if f0_normalizer is not None else normalize_f0
        self.syllables = SyllableStitchStream(seed=seed)

        self._queue: queue.Queue = queue.Queue(maxsize=max(16, int(buffer_capacity)))
        self._shuffle_window = max(16, int(shuffle_window))
        self._stop = threading.Event()
        self._eof = False
        self._thread: Optional[threading.Thread] = None
        self._error: Optional[BaseException] = None
        self.stats = {
            "aishell3_clips": 0,
            "kespeech_clips": 0,
            "librispeech_clips": 0,
            "syllable_clips": 0,
            "emotion_clips": 0,
            "singing_clips": 0,
            "singing_skipped_high_f0": 0,
            "total_seconds": 0.0,
        }

    def _infinite_aishell3(self) -> Iterator[Tuple[str, np.ndarray]]:
        while not self._stop.is_set():
            yield from iter_aishell3_tar(AISHELL3_TAR, split="train", min_sec=1.2)

    def _infinite_kespeech(self) -> Iterator[Tuple[str, np.ndarray]]:
        while not self._stop.is_set():
            yield from iter_kespeech_splits(KESPEECH_SPLITS_DIR, min_sec=1.2)

    def _infinite_librispeech(self) -> Iterator[Tuple[str, np.ndarray]]:
        while not self._stop.is_set():
            yield from iter_librispeech_tar(LIBRISPEECH_DIR / "train-clean-100.tar.gz", min_sec=1.2)

    def _infinite_audio_dirs(self, dirs: List[Path], seed_offset: int, recursive: bool = False) -> Iterator[Tuple[str, np.ndarray]]:
        ep = 0
        while not self._stop.is_set():
            ep += 1
            yield from iter_audio_dirs(
                dirs,
                min_sec=1.0,
                max_sec=45.0,
                seed=self._base_seed + seed_offset + ep * 97,
                recursive=recursive,
            )

    def _slice_clip(self, audio: np.ndarray) -> np.ndarray:
        seg_s = self.segment_samples
        if len(audio) >= seg_s:
            start = int(self.rng.integers(0, len(audio) - seg_s + 1)) if len(audio) > seg_s else 0
            return audio[start:start + seg_s].astype(np.float32)
        out = np.zeros(seg_s, dtype=np.float32)
        out[:len(audio)] = audio
        return out

    def _producer(self) -> None:
        ai_iter = self._infinite_aishell3() if self.weights.get("aishell3", 0.0) > 0 else None
        ke_iter = self._infinite_kespeech() if self.weights.get("kespeech", 0.0) > 0 else None
        ls_iter = self._infinite_librispeech() if self.weights.get("librispeech", 0.0) > 0 else None
        em_iter = self._infinite_audio_dirs(self.emotion_dirs, 701, recursive=True) if self.weights.get("emotion", 0.0) > 0 and self.emotion_dirs else None
        sg_iter = self._infinite_audio_dirs(self.singing_dirs, 907, recursive=True) if self.weights.get("singing", 0.0) > 0 and self.singing_dirs else None
        names = [k for k, v in self.weights.items() if v > 0]
        probs = np.array([self.weights[k] for k in names], dtype=np.float64)
        probs /= probs.sum()

        ring: deque = deque()
        produced_sec = 0.0

        try:
            while not self._stop.is_set() and produced_sec < self.max_seconds:
                src = str(self.rng.choice(names, p=probs))
                if src == "aishell3" and ai_iter is not None:
                    _, wav = next(ai_iter)
                    self.stats["aishell3_clips"] += 1
                elif src == "kespeech" and ke_iter is not None:
                    _, wav = next(ke_iter)
                    self.stats["kespeech_clips"] += 1
                elif src == "librispeech" and ls_iter is not None:
                    _, wav = next(ls_iter)
                    self.stats["librispeech_clips"] += 1
                elif src == "emotion" and em_iter is not None:
                    _, wav = next(em_iter)
                    self.stats["emotion_clips"] += 1
                elif src == "singing" and sg_iter is not None:
                    _, wav = next(sg_iter)
                    self.stats["singing_clips"] += 1
                else:
                    _, wav = self.syllables.sample_utterance(target_sec=self.segment_samples / SAMPLE_RATE_16K)
                    self.stats["syllable_clips"] += 1

                # 长音频最多切 2 段互不浪费
                n_slices = 2 if len(wav) >= 2 * self.segment_samples else 1
                for _ in range(n_slices):
                    if produced_sec >= self.max_seconds or self._stop.is_set():
                        break
                    clip = self._slice_clip(wav)
                    valid_frames = min(self.segment_frames, max(1, len(wav) // WAVLM_HOP_SAMPLES))
                    mask = np.zeros(self.segment_frames, dtype=np.float32)
                    mask[:valid_frames] = 1.0

                    f0_hz, voiced = self.pitch_extractor.extract_50hz(clip, num_frames=self.segment_frames)
                    if src == "singing" and self.singing_f0_max_p95 > 0.0 and bool(np.any(voiced)):
                        if float(np.percentile(f0_hz[voiced], 95)) > self.singing_f0_max_p95:
                            self.stats["singing_skipped_high_f0"] += 1
                            continue
                    f0_norm = self._f0_normalizer(f0_hz)

                    ring.append((clip, f0_norm, mask))
                    produced_sec += valid_frames * 0.020
                    self.stats["total_seconds"] = produced_sec

                    if len(ring) >= self._shuffle_window:
                        pick_idx = int(self.rng.integers(0, len(ring)))
                        item = ring[pick_idx]
                        ring[pick_idx] = ring[-1]
                        ring.pop()
                        while not self._stop.is_set():
                            try:
                                self._queue.put(item, timeout=0.2)
                                break
                            except queue.Full:
                                continue

            while ring and not self._stop.is_set():
                item = ring.popleft()
                while not self._stop.is_set():
                    try:
                        self._queue.put(item, timeout=0.2)
                        break
                    except queue.Full:
                        continue
        except BaseException as exc:
            self._error = exc
        finally:
            while True:
                try:
                    self._queue.put(None, timeout=0.2)
                    break
                except queue.Full:
                    if self._stop.is_set():
                        break

    def start(self) -> None:
        if self._thread is not None:
            return
        self._stop.clear()
        self._eof = False
        self._thread = threading.Thread(target=self._producer, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=3.0)
            self._thread = None

    def next_batch(self, batch_size: int) -> Optional[Tuple[torch.Tensor, torch.Tensor, torch.Tensor]]:
        if self._eof:
            return None
        self.start()
        wavs, f0s, masks = [], [], []
        for _ in range(batch_size):
            item = self._queue.get()
            if item is None:
                self._eof = True
                if self._error is not None:
                    raise RuntimeError(f"流式读取后台异常: {self._error}") from self._error
                break
            w, f, m = item
            wavs.append(w)
            f0s.append(f)
            masks.append(m)
        if not wavs:
            return None
        return (
            torch.from_numpy(np.stack(wavs, axis=0)),
            torch.from_numpy(np.stack(f0s, axis=0)),
            torch.from_numpy(np.stack(masks, axis=0)),
        )
