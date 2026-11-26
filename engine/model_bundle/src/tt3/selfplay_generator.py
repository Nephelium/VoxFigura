"""Model-in-the-loop physical R21 self-play corpus generator for expanding paired TT3 data."""
from __future__ import annotations

from concurrent.futures import ProcessPoolExecutor
import json
from math import ceil
import os
from pathlib import Path
import time
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import torch
import torch.nn.functional as F

from .constants import (
    HF_CACHE_DIR,
    SAMPLE_RATE_16K,
    WAVLM_HOP_SAMPLES,
    denormalize_f0,
    denormalize_m20,
    denormalize_pr,
)
from .inference import safe_torch_load, select_inference_device
from .models import FrozenWavLM, MotorEncoder, PressureEncoder
from .streaming_corpora import StreamingNaturalPool
from .vtl_synth import R21Synthesizer

_SP_SYNTH: Optional[R21Synthesizer] = None


def _init_r21_worker() -> None:
    global _SP_SYNTH
    _SP_SYNTH = R21Synthesizer(section_count=65)


def _synth_chunk_worker(m22_list: List[np.ndarray]) -> List[Optional[np.ndarray]]:
    assert _SP_SYNTH is not None
    outputs: List[Optional[np.ndarray]] = []
    for m22 in m22_list:
        res = _SP_SYNTH.synthesize_50hz(m22, return_48k=False)
        if res is None:
            outputs.append(None)
            continue
        _, wav_16k = res
        expected_samples = m22.shape[0] * WAVLM_HOP_SAMPLES
        if len(wav_16k) < expected_samples:
            outputs.append(None)
            continue
        trimmed = np.asarray(wav_16k[:expected_samples], dtype=np.float32)
        if not np.isfinite(trimmed).all() or float(np.max(np.abs(trimmed))) < 0.002:
            outputs.append(None)
            continue
        outputs.append(trimmed)
    return outputs


def _gate_deep_silence_pr(
    wav_16k: np.ndarray,
    m22_50hz: np.ndarray,
    silence_gate_rms: float,
) -> np.ndarray:
    """Zero glottal driving on true dead-silence frames (< -54 dBFS and >= 32 dB below speech)."""
    if silence_gate_rms <= 0.0:
        return m22_50hz
    n_frames = m22_50hz.shape[0]
    usable = n_frames * WAVLM_HOP_SAMPLES
    if len(wav_16k) < usable or n_frames < 1:
        return m22_50hz
    frames = np.asarray(wav_16k[:usable], dtype=np.float64).reshape(n_frames, WAVLM_HOP_SAMPLES)
    frame_rms = np.sqrt(np.mean(frames * frames, axis=1))
    p95 = float(np.percentile(frame_rms, 95))
    thresh = min(float(silence_gate_rms), 0.025 * p95)
    silent = frame_rms < thresh
    if not np.any(silent):
        return m22_50hz
    out = m22_50hz.copy()
    out[silent, 17] = 0.12  # XB
    out[silent, 18] = 0.05  # CA
    out[silent, 19] = 0.0   # RA
    out[silent, 20] = 0.0   # PR
    return out


def _flush_shard(
    *,
    out_dir: Path,
    manifest_path: Path,
    shard_idx: int,
    audio_chunks: List[np.ndarray],
    m22_chunks: List[np.ndarray],
    cos_vals: List[float],
    attempts_in_shard: int,
    failed_in_shard: int,
    filtered_in_shard: int,
) -> Dict[str, Any]:
    shard_path = out_dir / f"shard_{shard_idx:06d}.npz"
    tmp_path = out_dir / f"shard_{shard_idx:06d}.tmp.npz"

    audio_offsets = [0]
    frame_offsets = [0]
    total_samples = 0
    for a, m in zip(audio_chunks, m22_chunks):
        total_samples += len(a)
        audio_offsets.append(audio_offsets[-1] + len(a))
        frame_offsets.append(frame_offsets[-1] + len(m))

    np.savez(
        tmp_path,
        audio_i16=np.concatenate(audio_chunks),
        m22_f16=np.concatenate(m22_chunks, axis=0),
        audio_offsets=np.asarray(audio_offsets, dtype=np.int64),
        frame_offsets=np.asarray(frame_offsets, dtype=np.int64),
    )
    os.replace(tmp_path, shard_path)

    rec: Dict[str, Any] = {
        "shard_idx": int(shard_idx),
        "file": shard_path.name,
        "num_utts": len(audio_chunks),
        "attempts": int(attempts_in_shard),
        "failed": int(failed_in_shard),
        "filtered_low_cos": int(filtered_in_shard),
        "seconds": round(total_samples / SAMPLE_RATE_16K, 3),
        "bytes": int(shard_path.stat().st_size),
        "mean_cos": round(float(np.mean(cos_vals)), 4) if cos_vals else 0.0,
        "source": "selfplay",
    }
    with open(manifest_path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
    return rec


def _load_existing_manifest(out_dir: Path, manifest_path: Path) -> List[Dict[str, Any]]:
    if not manifest_path.is_file():
        return []
    by_idx: Dict[int, Dict[str, Any]] = {}
    for line in manifest_path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        rec = json.loads(line)
        if (out_dir / rec["file"]).is_file():
            by_idx[int(rec["shard_idx"])] = rec
    records = list(by_idx.values())
    records.sort(key=lambda r: int(r["shard_idx"]))
    return records


def generate_selfplay_corpus(
    out_dir: Path,
    *,
    pr_ckpt: Path,
    motor_ckpt: Path,
    target_hours: float = 110.0,
    utts_per_shard: int = 100,
    workers: int = 12,
    gpu_batch_size: int = 32,
    segment_frames: int = 180,
    min_valid_frames: int = 60,
    min_cos: float = 0.70,
    silence_gate_rms: float = 0.002,
    seed: int = 20261121,
    resume: bool = True,
    device_pref: str = "auto",
) -> Dict[str, Any]:
    """Generate physical R21 paired shards driven by trained inversion + natural speech."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = out_dir / "manifest.jsonl"

    target_seconds = float(target_hours) * 3600.0
    existing = _load_existing_manifest(out_dir, manifest_path) if resume else []
    base_sec = sum(float(r["seconds"]) for r in existing)

    if base_sec >= target_seconds:
        manifest_path.write_text(
            "\n".join(json.dumps(r, ensure_ascii=False) for r in existing) + ("\n" if existing else ""),
            encoding="utf-8",
        )
        return {
            "out_dir": str(out_dir),
            "n_shards": len(existing),
            "total_utts": sum(int(r["num_utts"]) for r in existing),
            "total_hours": round(base_sec / 3600.0, 4),
            "total_seconds": round(base_sec, 2),
            "total_mb": round(sum(int(r["bytes"]) for r in existing) / (1024 ** 2), 2),
            "new_seconds": 0.0,
            "wall_seconds": 0.0,
            "realtime_factor": 0.0,
            "mean_cos": round(float(np.mean([r.get("mean_cos", 0.0) for r in existing])), 4) if existing else 0.0,
        }

    device = select_inference_device(device_pref)
    use_bf16 = device.type == "cuda"

    wavlm = FrozenWavLM(cache_dir=HF_CACHE_DIR).to(device)
    pr_encoder = PressureEncoder().to(device)
    pr_encoder.load_state_dict(safe_torch_load(Path(pr_ckpt), map_location="cpu")["model"])
    pr_encoder.eval()

    motor_data = safe_torch_load(Path(motor_ckpt), map_location="cpu")
    mode = motor_data.get("extra", {}).get("mode", "T24")
    motor_encoder = MotorEncoder(mode=mode).to(device)
    motor_encoder.load_state_dict(motor_data["model"])
    motor_encoder.eval()

    next_shard_idx = (int(existing[-1]["shard_idx"]) + 1) if existing else 0
    pool_buf = min(128, max(32, int(gpu_batch_size) * 2))
    stream_pool = StreamingNaturalPool(
        segment_frames=int(segment_frames),
        max_hours=max(float(target_hours) * 3.0, 20.0),
        buffer_capacity=pool_buf,
        shuffle_window=pool_buf,
        seed=int(seed) + next_shard_idx * 997,
    )

    n_workers = max(1, int(workers))
    eff_utts_per_shard = max(4, int(utts_per_shard))
    shard_idx = next_shard_idx
    shard_audio: List[np.ndarray] = []
    shard_m22: List[np.ndarray] = []
    shard_cos: List[float] = []
    shard_sec = 0.0
    sh_attempts = 0
    sh_failed = 0
    sh_filtered = 0

    new_records: List[Dict[str, Any]] = []
    done_new_sec = 0.0
    tot_attempts = sum(int(r.get("attempts", 0)) for r in existing)
    tot_kept = sum(int(r.get("num_utts", 0)) for r in existing)
    t0 = time.perf_counter()

    try:
        with ProcessPoolExecutor(max_workers=n_workers, initializer=_init_r21_worker) as executor:
            while (base_sec + done_new_sec + shard_sec) < target_seconds:
                batch = stream_pool.next_batch(int(gpu_batch_size))
                if batch is None:
                    break
                wav_b, f0_norm_b, mask_b = batch
                wav_dev = wav_b.to(device)
                mask_dev = mask_b.to(device)

                with torch.inference_mode():
                    w25 = wavlm(wav_dev, mask_dev, use_bf16=use_bf16)
                    w24_ref = w25[:, 24, :, :]
                    pr_norm = pr_encoder(w25, mask_dev)[..., 0].cpu().numpy()
                    m20_norm = motor_encoder(w25, mask_dev).cpu().numpy()

                wav_np = wav_b.numpy()
                f0_np = denormalize_f0(f0_norm_b.numpy())
                mask_np = mask_b.numpy()
                m20_phys = denormalize_m20(m20_norm)
                pr_phys = denormalize_pr(pr_norm)

                cands: List[Tuple[int, int, np.ndarray]] = []
                for bi in range(wav_np.shape[0]):
                    valid_f = int(round(float(mask_np[bi].sum())))
                    if valid_f < int(min_valid_frames):
                        continue
                    m22_seq = np.concatenate(
                        [
                            m20_phys[bi, :valid_f],
                            pr_phys[bi, :valid_f, None],
                            f0_np[bi, :valid_f, None],
                        ],
                        axis=1,
                    ).astype(np.float32)
                    m22_seq = _gate_deep_silence_pr(wav_np[bi, : valid_f * WAVLM_HOP_SAMPLES], m22_seq, silence_gate_rms)
                    cands.append((bi, valid_f, m22_seq))

                if not cands:
                    continue

                m22_inputs = [c[2] for c in cands]
                chunk_size = max(1, ceil(len(m22_inputs) / n_workers))
                work_slices = [m22_inputs[k : k + chunk_size] for k in range(0, len(m22_inputs), chunk_size)]
                syn_flat: List[Optional[np.ndarray]] = []
                for sub_out in executor.map(_synth_chunk_worker, work_slices):
                    syn_flat.extend(sub_out)

                ok_items: List[Tuple[int, int, np.ndarray, np.ndarray]] = []
                for (bi, valid_f, m22_seq), syn_wav in zip(cands, syn_flat):
                    if syn_wav is None:
                        sh_attempts += 1
                        tot_attempts += 1
                        sh_failed += 1
                    else:
                        ok_items.append((bi, valid_f, m22_seq, syn_wav))

                if not ok_items:
                    continue

                # Batch WavLM L24 verification for all surviving R21 realizations
                m_ok = len(ok_items)
                syn_batch = np.zeros((m_ok, int(segment_frames) * WAVLM_HOP_SAMPLES), dtype=np.float32)
                syn_mask = np.zeros((m_ok, int(segment_frames)), dtype=np.float32)
                ref_indices: List[int] = []
                for row_i, (bi, valid_f, _, syn_wav) in enumerate(ok_items):
                    syn_batch[row_i, : len(syn_wav)] = syn_wav
                    syn_mask[row_i, :valid_f] = 1.0
                    ref_indices.append(bi)

                with torch.inference_mode():
                    syn_w25 = wavlm(
                        torch.from_numpy(syn_batch).to(device),
                        torch.from_numpy(syn_mask).to(device),
                        use_bf16=use_bf16,
                    )
                    w24_syn = syn_w25[:, 24, :, :]
                    w24_ref_sub = w24_ref[ref_indices]
                    m_t = torch.from_numpy(syn_mask).to(device)
                    cos_frame = F.cosine_similarity(w24_syn.float(), w24_ref_sub.float(), dim=-1)
                    cos_per_utt = ((cos_frame * m_t).sum(dim=1) / torch.clamp(m_t.sum(dim=1), min=1.0)).cpu().numpy()

                for row_i, (_, valid_f, m22_seq, syn_wav) in enumerate(ok_items):
                    sh_attempts += 1
                    tot_attempts += 1
                    cos_val = float(cos_per_utt[row_i])
                    if not np.isfinite(cos_val) or cos_val < float(min_cos):
                        sh_filtered += 1
                        continue

                    peak = float(np.max(np.abs(syn_wav)))
                    scale = max(1.0, peak)
                    audio_i16 = np.rint(np.clip(syn_wav / scale, -1.0, 1.0) * 32767.0).astype(np.int16)
                    shard_audio.append(audio_i16)
                    shard_m22.append(m22_seq.astype(np.float16))
                    shard_cos.append(cos_val)
                    shard_sec += len(audio_i16) / SAMPLE_RATE_16K
                    tot_kept += 1

                    need_flush = len(shard_audio) >= eff_utts_per_shard or (
                        base_sec + done_new_sec + shard_sec >= target_seconds
                    )
                    if need_flush:
                        rec = _flush_shard(
                            out_dir=out_dir,
                            manifest_path=manifest_path,
                            shard_idx=shard_idx,
                            audio_chunks=shard_audio,
                            m22_chunks=shard_m22,
                            cos_vals=shard_cos,
                            attempts_in_shard=sh_attempts,
                            failed_in_shard=sh_failed,
                            filtered_in_shard=sh_filtered,
                        )
                        new_records.append(rec)
                        done_new_sec += float(rec["seconds"])
                        shard_idx += 1
                        shard_audio.clear()
                        shard_m22.clear()
                        shard_cos.clear()
                        shard_sec = 0.0
                        sh_attempts = 0
                        sh_failed = 0
                        sh_filtered = 0

                        elapsed_s = max(1e-6, time.perf_counter() - t0)
                        tot_sec = base_sec + done_new_sec
                        tot_h = tot_sec / 3600.0
                        rtf = done_new_sec / elapsed_s
                        keep_pct = 100.0 * tot_kept / max(1, tot_attempts)
                        rem_sec = max(0.0, target_seconds - tot_sec)
                        eta_h = (rem_sec / rtf) / 3600.0 if rtf > 1e-6 else 0.0
                        print(
                            f"[SelfPlay] shard {len(existing) + len(new_records)} ({rec['file']}) | "
                            f"total={tot_h:.2f}/{target_hours:.1f}h | rtf={rtf:.2f}x | "
                            f"keep={keep_pct:.1f}% | cos={rec['mean_cos']:.4f} | eta={eta_h:.2f}h",
                            flush=True,
                        )
                        if device.type == "cuda" and (len(new_records) % 20 == 0):
                            torch.cuda.empty_cache()
                        if (base_sec + done_new_sec) >= target_seconds:
                            break

            if shard_audio and (base_sec + done_new_sec) < target_seconds:
                rec = _flush_shard(
                    out_dir=out_dir,
                    manifest_path=manifest_path,
                    shard_idx=shard_idx,
                    audio_chunks=shard_audio,
                    m22_chunks=shard_m22,
                    cos_vals=shard_cos,
                    attempts_in_shard=sh_attempts,
                    failed_in_shard=sh_failed,
                    filtered_in_shard=sh_filtered,
                )
                new_records.append(rec)
                done_new_sec += float(rec["seconds"])
    finally:
        stream_pool.stop()
        if device.type == "cuda":
            torch.cuda.empty_cache()

    elapsed = time.perf_counter() - t0
    all_records = _load_existing_manifest(out_dir, manifest_path)
    tmp_manifest = manifest_path.with_suffix(".tmp.jsonl")
    tmp_manifest.write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in all_records) + ("\n" if all_records else ""),
        encoding="utf-8",
    )
    os.replace(tmp_manifest, manifest_path)

    total_sec = sum(float(r["seconds"]) for r in all_records)
    total_bytes = sum(int(r["bytes"]) for r in all_records)
    cos_list = [float(r["mean_cos"]) for r in all_records if "mean_cos" in r]
    return {
        "out_dir": str(out_dir),
        "n_shards": len(all_records),
        "total_utts": sum(int(r["num_utts"]) for r in all_records),
        "total_hours": round(total_sec / 3600.0, 4),
        "total_seconds": round(total_sec, 2),
        "total_mb": round(total_bytes / (1024 ** 2), 2),
        "keep_rate": round(tot_kept / max(1, tot_attempts), 4),
        "mean_cos": round(float(np.mean(cos_list)), 4) if cos_list else 0.0,
        "new_seconds": round(done_new_sec, 2),
        "wall_seconds": round(elapsed, 2),
        "realtime_factor": round(done_new_sec / max(1e-6, elapsed), 2),
    }
