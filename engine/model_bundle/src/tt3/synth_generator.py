"""Monte-Carlo pseudo-speech & Target Approximation Model generator for M10 R21 (JD2)."""
from __future__ import annotations

from concurrent.futures import ProcessPoolExecutor, as_completed
import json
import os
from pathlib import Path
import time
from typing import Dict, List, Optional, Tuple

import numpy as np

from .constants import (
    CONTROL_HZ_200,
    CONTROL_HZ_50,
    F0_MAX,
    F0_MIN,
    M22_MAX,
    M22_MIN,
    PR_MAX,
    SAMPLE_RATE_16K,
    STATES_DEFAULT_PATH,
    WAVLM_HOP_SAMPLES,
)
from .vtl_synth import R21Synthesizer


# 目标近似参数：声道 15 ms，声门与基频控制对应 6 ms / 20 ms
TAU_TRACT_SEC = 0.015
TAU_GLOTTIS_SEC = 0.006
TAU_F0_SEC = 0.020


def target_approximation_filter(
    targets: np.ndarray,
    dt: float,
    tau: float,
) -> np.ndarray:
    """三阶临界阻尼目标近似（Xu & Wang 2001 / Prom-on et al. 2009 解析递推近似）。

    targets: (T, D) 分段常值目标序列。
    在步长 dt 下逐段寻找跃变边界并计算 C^2 连续三阶临界阻尼响应。
    """
    seq = np.asarray(targets, dtype=np.float64)
    n_steps, n_dims = seq.shape
    out = np.empty_like(seq)
    if n_steps == 0:
        return out

    lam = 1.0 / max(1e-4, float(tau))
    # 找每段持续常值区间（逐维度独立检测或按统一步长跃变；每维度独立检测能精准处理声门异步偏移）
    for d in range(n_dims):
        col = seq[:, d]
        y0 = float(col[0])
        yp0 = 0.0
        ypp0 = 0.0
        seg_start = 0
        # 找出值变化点
        changes = np.flatnonzero(np.abs(np.diff(col)) > 1e-9) + 1
        bounds = np.concatenate(([0], changes, [n_steps]))
        for i in range(len(bounds) - 1):
            a, b = int(bounds[i]), int(bounds[i + 1])
            target_val = float(col[a])
            t = np.arange(b - a, dtype=np.float64) * dt
            c0 = y0 - target_val
            c1 = yp0 + lam * c0
            c2 = 0.5 * ypp0 + lam * yp0 + 0.5 * (lam ** 2) * c0
            exp_lt = np.exp(-lam * t)
            poly = c0 + c1 * t + c2 * (t ** 2)
            out[a:b, d] = target_val + poly * exp_lt

            # 更新下一段起点连续初值（推进整段长度 (b - a) * dt）
            t_end = float(b - a) * dt
            e_end = float(np.exp(-lam * t_end))
            p_end = c0 + c1 * t_end + c2 * (t_end ** 2)
            dp_end = c1 + 2.0 * c2 * t_end
            d2p_end = 2.0 * c2
            y0 = target_val + p_end * e_end
            yp0 = (dp_end - lam * p_end) * e_end
            ypp0 = (d2p_end - 2.0 * lam * dp_end + (lam ** 2) * p_end) * e_end
    return out


class StateBankLoader:
    """加载 states_jd2_r21.npz 供多进程生成器复用。"""

    def __init__(self, path: Path = STATES_DEFAULT_PATH) -> None:
        with np.load(path, allow_pickle=False) as d:
            self.vowels = np.asarray(d["vowels"], dtype=np.float64)
            self.closures = np.asarray(d["closures"], dtype=np.float64)
            self.fricatives = np.asarray(d["fricatives"], dtype=np.float64)
            self.laterals = np.asarray(d["laterals"], dtype=np.float64)
            self.approximants = np.asarray(d["approximants"], dtype=np.float64)


def _sample_random_utterance_targets(
    bank: StateBankLoader,
    rng: np.random.Generator,
    min_sec: float = 2.0,
    max_sec: float = 5.6,
) -> Tuple[np.ndarray, np.ndarray]:
    """构造一条伪语音的 200 Hz (5 ms/步) 分段目标序列及对应的 200 Hz 平滑轨迹。"""
    target_50_frames = int(rng.integers(round(min_sec * CONTROL_HZ_50), round(max_sec * CONTROL_HZ_50) + 1))
    n_steps = target_50_frames * (CONTROL_HZ_200 // CONTROL_HZ_50)  # * 4

    # 先按音段生成离散事件流：每项为 (n_200_steps, tract17, kind, voiced, nasal_vo)
    events: List[Tuple[int, np.ndarray, str, bool, float]] = []

    def ms_to_steps(ms: float) -> int:
        return max(2, int(round(ms * 0.001 * CONTROL_HZ_200)))

    # 句首随机静音（60..220 ms）
    if rng.random() < 0.85:
        v0 = bank.vowels[int(rng.integers(len(bank.vowels)))].copy()
        events.append((ms_to_steps(rng.uniform(60, 220)), v0, "silence", False, -0.1))

    acc_steps = sum(ev[0] for ev in events)
    next_is_vowel = bool(rng.random() < 0.6)
    while acc_steps < n_steps - ms_to_steps(120):
        # 句中偶尔插入停顿，让 PR-Encoder 学习清晰的话音-停顿切分
        if len(events) >= 3 and rng.random() < 0.08:
            pause_steps = ms_to_steps(rng.uniform(90, 260))
            last_tract = events[-1][1].copy()
            events.append((pause_steps, last_tract, "silence", False, -0.1))
            acc_steps += pause_steps
            continue

        dur_steps = ms_to_steps(rng.uniform(50, 200))
        if next_is_vowel:
            tract = bank.vowels[int(rng.integers(len(bank.vowels)))].copy()
            # 15% 概率鼻化元音
            vo = float(rng.uniform(0.25, 0.70)) if rng.random() < 0.15 else -0.1
            tract[7] = vo
            events.append((dur_steps, tract, "vowel", True, vo))
            next_is_vowel = bool(rng.random() < 0.25)  # 元音后较高概率接辅音
        else:
            r = rng.random()
            if r < 0.32 and len(bank.closures) > 0:
                tract = bank.closures[int(rng.integers(len(bank.closures)))].copy()
                voiced = bool(rng.random() < 0.45)
                tract[7] = -0.1
                events.append((dur_steps, tract, "closure", voiced, -0.1))
            elif r < 0.66 and len(bank.fricatives) > 0:
                tract = bank.fricatives[int(rng.integers(len(bank.fricatives)))].copy()
                voiced = bool(rng.random() < 0.35)
                tract[7] = -0.1
                events.append((dur_steps, tract, "fricative", voiced, -0.1))
            elif r < 0.82 and len(bank.closures) > 0:
                # 鼻辅音：在口腔闭塞基础上打开腭咽口 VO
                tract = bank.closures[int(rng.integers(len(bank.closures)))].copy()
                vo = float(rng.uniform(0.35, 0.85))
                tract[7] = vo
                events.append((dur_steps, tract, "nasal", True, vo))
            elif r < 0.92 and len(bank.laterals) > 0:
                tract = bank.laterals[int(rng.integers(len(bank.laterals)))].copy()
                tract[7] = -0.1
                events.append((dur_steps, tract, "lateral", True, -0.1))
            else:
                tract = bank.approximants[int(rng.integers(len(bank.approximants)))].copy()
                tract[7] = -0.1
                events.append((dur_steps, tract, "approximant", True, -0.1))
            next_is_vowel = bool(rng.random() < 0.82)  # 辅音后高概率接元音，偶尔辅音连缀

        acc_steps += dur_steps

    # 句尾补静音直到精确对齐 n_steps
    rem = n_steps - acc_steps
    if rem > 0:
        last_tract = events[-1][1].copy() if events else bank.vowels[0].copy()
        events.append((rem, last_tract, "silence", False, -0.1))
    else:
        # 截断最后一个事件
        over = acc_steps - n_steps
        last_len, last_tr, last_k, last_v, last_vo = events[-1]
        events[-1] = (max(1, last_len - over), last_tr, last_k, last_v, last_vo)

    # 组装 200 Hz 目标矩阵
    raw_targets = np.empty((n_steps, 22), dtype=np.float64)
    f0_base = float(rng.uniform(85.0, 260.0))

    # 先填充声道 17 维和 F0
    cursor = 0
    seg_spans: List[Tuple[int, int, str, bool]] = []
    for seg_len, tract, kind, voiced, _ in events:
        end = min(n_steps, cursor + seg_len)
        if end <= cursor:
            continue
        raw_targets[cursor:end, :17] = tract
        # 为每个音段分配随机调高目标（±25%），保留语调起伏与声调变化
        seg_f0 = float(np.clip(f0_base * rng.uniform(0.75, 1.28), F0_MIN, F0_MAX))
        raw_targets[cursor:end, 21] = seg_f0
        seg_spans.append((cursor, end, kind, voiced))
        cursor = end

    # 声门默认浊音预设（Geometric glottis 2025）
    # XB=0.04, CA=0.02, RA=1.0, PR=8000
    raw_targets[:, 17] = 0.04
    raw_targets[:, 18] = 0.02
    raw_targets[:, 19] = 1.0
    raw_targets[:, 20] = PR_MAX

    # 第一遍：按各音段设置基础声门与肺压参数
    for s, e, kind, voiced in seg_spans:
        if kind == "silence":
            raw_targets[s:e, 17] = 0.12
            raw_targets[s:e, 18] = 0.05
            raw_targets[s:e, 19] = 0.0
            raw_targets[s:e, 20] = 0.0
        elif kind == "closure" and not voiced:
            raw_targets[s:e, 17] = 0.24
            raw_targets[s:e, 18] = 0.0
            raw_targets[s:e, 19] = 0.0
            raw_targets[s:e, 20] = PR_MAX
        elif kind == "fricative" and not voiced:
            raw_targets[s:e, 17] = 0.15
            raw_targets[s:e, 18] = 0.0
            raw_targets[s:e, 19] = 0.0
            raw_targets[s:e, 20] = PR_MAX
        elif not voiced:
            raw_targets[s:e, 17] = 0.10
            raw_targets[s:e, 18] = 0.04
            raw_targets[s:e, 19] = 0.0
            raw_targets[s:e, 20] = PR_MAX
        else:
            raw_targets[s:e, 17] = float(rng.uniform(0.032, 0.052))
            raw_targets[s:e, 18] = float(rng.uniform(0.012, 0.035))
            raw_targets[s:e, 19] = 1.0
            raw_targets[s:e, 20] = PR_MAX

    # 第二遍：按 Krug 2023 施加声门异步时序偏移（避免被邻段基础值覆盖）
    shift_pos_50ms = ms_to_steps(rng.uniform(30, 55))
    shift_neg_30ms = ms_to_steps(rng.uniform(20, 35))
    for idx_ev, (s, e, kind, voiced) in enumerate(seg_spans):
        if kind == "closure" and not voiced:
            # 紧随清塞音释放后的 30..55 ms 保持送气声门开度，形成真实 VOT（不覆盖静音段）
            next_kind = seg_spans[idx_ev + 1][2] if idx_ev + 1 < len(seg_spans) else "silence"
            if next_kind != "silence":
                ge = min(n_steps, e + shift_pos_50ms)
                if ge > e:
                    raw_targets[e:ge, 17] = 0.045
                    raw_targets[e:ge, 18] = 0.10
                    raw_targets[e:ge, 19] = 0.0
                    raw_targets[e:ge, 20] = PR_MAX
        elif kind == "fricative" and not voiced:
            # 清擦音前 20..35 ms 预提前开声门
            prev_kind = seg_spans[idx_ev - 1][2] if idx_ev > 0 else "silence"
            if prev_kind != "silence":
                gs = max(0, s - shift_neg_30ms)
                if s > gs:
                    raw_targets[gs:s, 17] = 0.15
                    raw_targets[gs:s, 18] = 0.0
                    raw_targets[gs:s, 19] = 0.0
                    raw_targets[gs:s, 20] = PR_MAX

    # 对声道 17 维、声门 4 维、F0 1 维分别做目标近似平滑
    dt = 1.0 / CONTROL_HZ_200
    smooth = np.empty_like(raw_targets)
    smooth[:, :17] = target_approximation_filter(raw_targets[:, :17], dt, TAU_TRACT_SEC)
    smooth[:, 17:21] = target_approximation_filter(raw_targets[:, 17:21], dt, TAU_GLOTTIS_SEC)
    smooth[:, 21:22] = target_approximation_filter(raw_targets[:, 21:22], dt, TAU_F0_SEC)

    # 夹紧物理范围
    smooth = np.clip(smooth, M22_MIN, M22_MAX)
    return raw_targets, smooth


# 多进程全局 worker 对象（每个子进程只初始化一次 VTL Engine）
_WORKER_SYNTH: Optional[R21Synthesizer] = None
_WORKER_BANK: Optional[StateBankLoader] = None


def _init_worker(state_path_str: str) -> None:
    global _WORKER_SYNTH, _WORKER_BANK
    _WORKER_SYNTH = R21Synthesizer(section_count=65)
    _WORKER_BANK = StateBankLoader(Path(state_path_str))


def _close_worker() -> None:
    global _WORKER_SYNTH
    if _WORKER_SYNTH is not None:
        _WORKER_SYNTH.close()
        _WORKER_SYNTH = None


def _generate_shard_task(args: Tuple[int, int, int, str, float, float]) -> Dict[str, object]:
    shard_idx, utts_per_shard, base_seed, out_dir_str, min_sec, max_sec = args
    assert _WORKER_SYNTH is not None and _WORKER_BANK is not None

    rng = np.random.default_rng(base_seed + shard_idx * 100003)
    out_dir = Path(out_dir_str)
    shard_path = out_dir / f"shard_{shard_idx:06d}.npz"
    tmp_path = out_dir / f"shard_{shard_idx:06d}.tmp.npz"

    audio_chunks: List[np.ndarray] = []
    m22_chunks: List[np.ndarray] = []
    audio_offsets = [0]
    frame_offsets = [0]

    attempts = 0
    failed = 0
    total_samples = 0
    max_attempts = utts_per_shard * 3

    while len(audio_chunks) < utts_per_shard and attempts < max_attempts:
        attempts += 1
        _, m22_200 = _sample_random_utterance_targets(_WORKER_BANK, rng, min_sec=min_sec, max_sec=max_sec)
        res = _WORKER_SYNTH.synthesize_200hz(m22_200, return_48k=False)
        if res is None:
            failed += 1
            continue
        _, wav_16k = res

        # 检查是否意外近似全静音
        peak = float(np.max(np.abs(wav_16k)))
        if peak < 0.002 or not np.isfinite(wav_16k).all():
            failed += 1
            continue

        # 精确对齐 50 Hz 网格
        n_frames = m22_200.shape[0] // 4
        expected_samples = n_frames * WAVLM_HOP_SAMPLES
        wav_16k = wav_16k[:expected_samples]
        if len(wav_16k) != expected_samples:
            failed += 1
            continue

        # 200 Hz 下采样到 50 Hz：取每 4 步（20 ms 窗）均值；PR 使用中位数避免阶跃过度模糊
        reshaped = m22_200[:n_frames * 4].reshape(n_frames, 4, 22)
        m22_50 = reshaped.mean(axis=1)
        m22_50[:, 20] = np.median(reshaped[:, :, 20], axis=1)

        # 如果波形峰值 > 1.0 才按 peak 缩放防削波，否则保留真实幅度进 int16
        scale = max(1.0, peak)
        audio_i16 = np.rint(np.clip(wav_16k / scale, -1.0, 1.0) * 32767.0).astype(np.int16)

        audio_chunks.append(audio_i16)
        m22_chunks.append(m22_50.astype(np.float16))
        total_samples += expected_samples
        audio_offsets.append(audio_offsets[-1] + expected_samples)
        frame_offsets.append(frame_offsets[-1] + n_frames)

    if not audio_chunks:
        raise RuntimeError(f"分片 {shard_idx} 连续 {attempts} 次合成均失败！")

    np.savez(
        tmp_path,
        audio_i16=np.concatenate(audio_chunks),
        m22_f16=np.concatenate(m22_chunks, axis=0),
        audio_offsets=np.asarray(audio_offsets, dtype=np.int64),
        frame_offsets=np.asarray(frame_offsets, dtype=np.int64),
    )
    os.replace(tmp_path, shard_path)

    return {
        "shard_idx": shard_idx,
        "file": shard_path.name,
        "num_utts": len(audio_chunks),
        "attempts": attempts,
        "failed": failed,
        "seconds": total_samples / SAMPLE_RATE_16K,
        "bytes": shard_path.stat().st_size,
    }


def generate_synthetic_corpus(
    out_dir: Path,
    state_bank_path: Path = STATES_DEFAULT_PATH,
    *,
    target_hours: float = 0.05,
    utts_per_shard: int = 200,
    workers: int = 8,
    min_sec: float = 2.0,
    max_sec: float = 5.6,
    seed: int = 20261119,
    resume: bool = True,
) -> Dict[str, object]:
    """多进程生成分片合成语料，支持断点续跑并写 manifest.jsonl。"""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = out_dir / "manifest.jsonl"

    avg_sec = 0.5 * (min_sec + max_sec)
    target_seconds = float(target_hours) * 3600.0
    # 估算需要多少条/多少分片（针对小规模冒烟适当缩减每片条数）
    if target_seconds / avg_sec < utts_per_shard:
        utts_per_shard = max(8, int(np.ceil(target_seconds / avg_sec)))
    n_shards = max(1, int(np.ceil(target_seconds / (utts_per_shard * avg_sec))))

    existing: Dict[int, dict] = {}
    if resume and manifest_path.is_file():
        for line in manifest_path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            rec = json.loads(line)
            if (out_dir / rec["file"]).is_file():
                existing[int(rec["shard_idx"])] = rec

    pending_tasks = [
        (idx, utts_per_shard, seed, str(out_dir), float(min_sec), float(max_sec))
        for idx in range(n_shards)
        if idx not in existing
    ]

    base_sec = sum(float(r["seconds"]) for r in existing.values())
    base_attempts = sum(int(r["attempts"]) for r in existing.values())
    base_failed = sum(int(r["failed"]) for r in existing.values())
    done_new_sec = 0.0
    done_attempts = 0
    done_failed = 0

    t0 = time.perf_counter()
    new_records: List[dict] = []
    if pending_tasks:
        n_workers = max(1, min(int(workers), len(pending_tasks)))
        with ProcessPoolExecutor(
            max_workers=n_workers,
            initializer=_init_worker,
            initargs=(str(state_bank_path),),
        ) as pool:
            futures = [pool.submit(_generate_shard_task, task) for task in pending_tasks]
            for fut in as_completed(futures):
                rec = fut.result()
                new_records.append(rec)
                with open(manifest_path, "a", encoding="utf-8") as fh:
                    fh.write(json.dumps(rec, ensure_ascii=False) + "\n")

                done_new_sec += float(rec["seconds"])
                done_attempts += int(rec["attempts"])
                done_failed += int(rec["failed"])
                elapsed_so_far = max(1e-6, time.perf_counter() - t0)
                tot_sec = base_sec + done_new_sec
                tot_h = tot_sec / 3600.0
                rtf = done_new_sec / elapsed_so_far
                tot_att = base_attempts + done_attempts
                tot_fail = base_failed + done_failed
                fail_pct = 100.0 * tot_fail / max(1, tot_att)
                rem_sec = max(0.0, target_seconds - tot_sec)
                eta_h = (rem_sec / rtf) / 3600.0 if rtf > 1e-6 else 0.0
                done_shards = len(existing) + len(new_records)
                print(
                    f"[Synth] shard {done_shards}/{n_shards} ({rec['file']}) | "
                    f"total={tot_h:.2f}/{target_hours:.1f}h | rtf={rtf:.2f}x | "
                    f"fail={fail_pct:.2f}% | eta={eta_h:.2f}h",
                    flush=True,
                )

    elapsed = time.perf_counter() - t0
    all_records = list(existing.values()) + new_records
    all_records.sort(key=lambda r: int(r["shard_idx"]))

    # 按序重写去重后的 manifest.jsonl
    manifest_path.write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in all_records) + ("\n" if all_records else ""),
        encoding="utf-8",
    )

    new_sec = sum(r["seconds"] for r in new_records)
    total_sec = sum(r["seconds"] for r in all_records)
    total_attempts = sum(r["attempts"] for r in all_records)
    total_failed = sum(r["failed"] for r in all_records)
    total_bytes = sum(r["bytes"] for r in all_records)

    return {
        "out_dir": str(out_dir),
        "n_shards": len(all_records),
        "total_utts": sum(r["num_utts"] for r in all_records),
        "total_hours": round(total_sec / 3600.0, 4),
        "total_seconds": round(total_sec, 2),
        "total_mb": round(total_bytes / (1024 ** 2), 2),
        "failure_rate": round(total_failed / max(1, total_attempts), 4),
        "new_seconds": round(new_sec, 2),
        "wall_seconds": round(elapsed, 2),
        "realtime_factor": round(new_sec / max(1e-6, elapsed), 2),
    }
