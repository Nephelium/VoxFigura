"""CPU-safe, zero-VRAM inference runtime for M27 Voice Morph.

Automatically loads the browser-light M27 inverter (14.8 MB FP16 / 7.6 MB INT8),
browser-light speaker encoder (5.7 MB FP16 / 2.9 MB INT8), and Stage 5 neural vocoder
(supporting frame-wise time-varying speaker SLERP!) plus optional 48 kHz R21 physical tube synthesis.
"""
from __future__ import annotations

from dataclasses import dataclass
from math import gcd
import os
from pathlib import Path
import sys
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from scipy.signal import resample_poly
import soundfile as sf
import torch
import torch.nn.functional as F

from .curves import compute_voicing_and_speech_gates
from .morpher import (
    DualMorphConfig,
    PresetMorphConfig,
    apply_dual_speaker_morph,
    apply_preset_phonation_morph,
    denormalize_m27_norm,
    normalize_m27_phys,
)
from .presets import CustomPresetStore, extract_phonation_preset_from_m27_phys

SAMPLE_RATE_16K = 16000
SAMPLE_RATE_48K = 48000
HOP_SAMPLES = 320  # 50 Hz @ 16 kHz


def _ensure_tt3_on_path(train_root: Path) -> None:
    src_dir = str(Path(train_root) / "src")
    if src_dir not in sys.path:
        sys.path.insert(0, src_dir)


def _normalize_playback(wav: np.ndarray, target_rms: float = 0.12, max_peak: float = 0.92) -> np.ndarray:
    arr = np.asarray(wav, dtype=np.float32).reshape(-1)
    if arr.size == 0:
        return arr
    arr = np.nan_to_num(arr, nan=0.0, posinf=0.0, neginf=0.0)
    rms = float(np.sqrt(np.mean(arr * arr)))
    if rms > 1e-5:
        arr = arr * (target_rms / rms)
    peak = float(np.max(np.abs(arr)))
    if peak > max_peak:
        arr = arr * (max_peak / peak)
    return np.ascontiguousarray(arr, dtype=np.float32)


def _waveform_envelope_peaks(wav_16k: np.ndarray, n_bins: int = 240) -> List[float]:
    arr = np.asarray(wav_16k, dtype=np.float32).reshape(-1)
    if arr.size == 0:
        return [0.0] * n_bins
    n_bins = max(16, min(n_bins, arr.size))
    edges = np.linspace(0, arr.size, n_bins + 1, dtype=np.int64)
    peaks = [float(np.max(np.abs(arr[edges[i] : max(edges[i] + 1, edges[i + 1])]))) for i in range(n_bins)]
    mx = max(max(peaks), 1e-5)
    return [round(p / mx, 4) for p in peaks]


@torch.inference_mode()
def synthesize_stage5_timevarying(
    gen: torch.nn.Module,
    m27_norm: torch.Tensor,
    spk_seq: torch.Tensor,
) -> torch.Tensor:
    """Run ConditionalHiFiGenerator27 with frame-wise time-varying speaker embeddings `(B, T, 512)`.

    Numerically equivalent to `gen.forward(m27_norm, spk_emb)` when `spk_seq` is constant over time,
    while allowing smooth mid-utterance speaker timbre morphing via SLERP without retraining!
    """
    spk_n = F.normalize(spk_seq.float(), p=2, dim=-1)  # (B, T, 512)
    cond_t = gen.spk_proj(spk_n)                       # (B, T, cond_dim)
    cond_seq = cond_t.transpose(1, 2)                  # (B, cond_dim, T)

    har_source = gen.m_source(m27_norm) if (gen.use_nsf and gen.m_source is not None) else None
    g_feat = (
        gen.glottis_enc(m27_norm[..., 17:27].float().transpose(1, 2))
        if (gen.glottis_enc is not None and gen.glottis_films)
        else None
    )

    x = gen.conv_pre(m27_norm.float().transpose(1, 2))  # (B, C, T)
    x = gen.cond_fuse(torch.cat([x, cond_seq], dim=1))

    for i, (up, mrf) in enumerate(zip(gen.ups, gen.mrfs)):
        x = F.leaky_relu(x, 0.1)
        x = up(x)
        if str(i) in gen.films:
            # Project per-frame speaker conditioning and upsample smoothly to current time resolution
            gb = gen.films[str(i)](cond_t).transpose(1, 2)  # (B, 2*C_i, T)
            gb = F.interpolate(gb, size=x.shape[-1], mode="linear", align_corners=False)
            gamma, beta = gb.chunk(2, dim=1)
            x = x * (1.0 + gamma) + beta
        if g_feat is not None and str(i) in gen.glottis_films:
            ggb = gen.glottis_films[str(i)](g_feat)
            ggb = F.interpolate(ggb, size=x.shape[-1], mode="linear", align_corners=False)
            g_gamma, g_beta = ggb.chunk(2, dim=1)
            x = x * (1.0 + g_gamma) + g_beta
        if gen.use_nsf and har_source is not None:
            x = x + gen.noise_convs[i](har_source)
        x = mrf(x)

    x = F.leaky_relu(x, 0.1)
    x = torch.tanh(gen.conv_post(x))
    return x.squeeze(1)


@dataclass
class AnalyzedClip:
    clip_id: str
    name: str
    wav_16k: np.ndarray
    m27_norm: np.ndarray
    m27_phys: np.ndarray
    f0_voiced: np.ndarray
    voiced_gate: np.ndarray
    speech_gate: np.ndarray
    spk_emb: np.ndarray
    dur_sec: float
    n_frames: int
    invert_ms: float

    def to_public_meta(self) -> Dict[str, Any]:
        return {
            "clip_id": self.clip_id,
            "name": self.name,
            "dur_sec": round(self.dur_sec, 3),
            "n_frames": int(self.n_frames),
            "invert_ms": round(self.invert_ms, 1),
            "waveform_peaks": _waveform_envelope_peaks(self.wav_16k, n_bins=240),
            "voiced_gate": [round(float(x), 3) for x in self.voiced_gate.tolist()],
            "speech_gate": [round(float(x), 3) for x in self.speech_gate.tolist()],
            "f0_hz": [round(float(x), 1) for x in self.m27_phys[:, 17].tolist()],
            "pr_norm": [round(float(x), 3) for x in self.m27_norm[:, 18].tolist()],
        }


class VoiceMorphEngine:
    """Self-contained CPU-safe engine powering both Python SDK calls and the web studio API."""

    MODEL_FILES = {
        "Vox2Tract-Lite": "vox2tract_lite_fp16.pt",
        "Vox2Spk-Lite": "vox2spk_lite_fp16.pt",
        "Tract2Vox-Lite": "tract2vox_lite_fp16.pt",
    }

    def __init__(
        self,
        *,
        train_root: Path = Path(__file__).resolve().parents[3],
        preset_store_path: Optional[Path] = None,
        device: str = "cpu",
    ) -> None:
        self.train_root = Path(train_root)
        self.device = torch.device(device)
        self._lock = threading.Lock()
        _ensure_tt3_on_path(self.train_root)

        self.preset_store = CustomPresetStore(
            preset_store_path or (self.train_root / "m27_voice_morph" / "custom_phonation_presets.json")
        )

        self._pitch = None
        self._inverter = None
        self._inverter_tag = ""
        self._spk_enc = None
        self._spk_tag = ""
        self._stage5_models: Dict[str, Tuple[torch.nn.Module, str]] = {}

    def bundled_model(self, name: str) -> Path:
        model_root = (self.train_root / "models").absolute()
        path = model_root / name / self.MODEL_FILES[name]
        if not path.is_file() or not path.resolve().is_relative_to(self.train_root.resolve()):
            raise FileNotFoundError(f"项目模型包缺少 {name} 权重")
        return path

    def _get_pitch(self):
        if self._pitch is None:
            from tt3.m27_contract import F0_MAX_M27, F0_MIN_M27
            from tt3.pitch import SwiftF0Extractor
            self._pitch = SwiftF0Extractor(fmin=F0_MIN_M27, fmax=F0_MAX_M27)
        return self._pitch

    def _get_inverter(self):
        if self._inverter is None:
            from tt3.browser_m27_models import BrowserLightM27Inverter, load_lite_state_dict

            path = self.bundled_model("Vox2Tract-Lite")
            sd, raw = load_lite_state_dict(path, map_location=str(self.device))
            cfg = raw.get("config") or raw.get("extra", {}).get("config")
            model = BrowserLightM27Inverter.from_arch_config(cfg).to(self.device).eval()
            model.load_state_dict(sd)
            self._inverter = model
            self._inverter_tag = f"Vox2Tract-Lite ({path.stat().st_size / 1024**2:.2f} MB)"
        return self._inverter

    def _get_spk_encoder(self):
        if self._spk_enc is None:
            from tt3.browser_m27_models import BrowserLightSpeakerEncoder, load_lite_state_dict

            path = self.bundled_model("Vox2Spk-Lite")
            sd, raw = load_lite_state_dict(path, map_location=str(self.device))
            cfg = raw.get("config") or raw.get("extra", {}).get("config")
            model = BrowserLightSpeakerEncoder.from_arch_config(cfg).to(self.device).eval()
            model.load_state_dict(sd)
            self._spk_enc = model
            self._spk_tag = f"Vox2Spk-Lite ({path.stat().st_size / 1024**2:.2f} MB)"
        return self._spk_enc

    def available_synthesizers(self) -> List[Dict[str, Any]]:
        items: List[Dict[str, Any]] = []
        s5_lite_fp16 = self.train_root / "models" / "Tract2Vox-Lite" / "tract2vox_lite_fp16.pt"
        s5_lite_ckpt = self.train_root / "runs" / "browser_m27_stage5" / "best.pt"
        s5_teacher = self.train_root / "runs" / "m27_v1" / "neural_synth" / "best.pt"
        if s5_lite_fp16.is_file():
            items.append({"id": "stage5_lite", "label": f"Stage 5 浏览器轻量声码器 ({s5_lite_fp16.stat().st_size / 1024**2:.1f} MB)", "sr": SAMPLE_RATE_16K})
        if s5_teacher.is_file():
            items.append({"id": "stage5_teacher", "label": "Stage 5 正式神经声码器 (14.35M · CPU 零抢卡)", "sr": SAMPLE_RATE_16K})
        if s5_lite_ckpt.is_file() and not s5_lite_fp16.is_file():
            items.append({"id": "stage5_lite_ckpt", "label": "Stage 5 浏览器轻量预览 (训练中最新 best.pt)", "sr": SAMPLE_RATE_16K})
        items.append({"id": "r21_physical", "label": "M10 R21 物理声管引擎 (48 kHz 纯物理声源-滤波器)", "sr": SAMPLE_RATE_48K})
        return items

    def _get_stage5_generator(self, synth_id: str) -> Tuple[torch.nn.Module, str]:
        if synth_id == "auto":
            avail = self.available_synthesizers()
            synth_id = avail[0]["id"] if avail else "r21_physical"
        if synth_id in self._stage5_models:
            return self._stage5_models[synth_id]

        from tt3.browser_m27_models import load_lite_state_dict
        from tt3.neural_synth_models import ConditionalHiFiGenerator27

        if synth_id == "stage5_lite":
            p = self.bundled_model("Tract2Vox-Lite")
            sd, raw = load_lite_state_dict(p, map_location=str(self.device))
            gen = ConditionalHiFiGenerator27.from_arch_config(raw.get("config")).to(self.device).eval()
            removed = bool((raw.get("meta") or {}).get("weight_norm_removed", True))
            if removed:
                gen.remove_weight_norm()
                gen.load_state_dict(sd, strict=True)
            else:
                gen.load_state_dict(sd, strict=True)
                gen.remove_weight_norm()
            label = f"Tract2Vox-Lite ({p.stat().st_size / 1024**2:.2f} MB)"
        elif synth_id == "stage5_lite_ckpt":
            p = self.train_root / "runs" / "browser_m27_stage5" / "best.pt"
            ck = torch.load(p, map_location=self.device, weights_only=False)
            gen = ConditionalHiFiGenerator27.from_arch_config(ck.get("generator_config")).to(self.device).eval()
            gen.load_state_dict(ck["generator"])
            gen.remove_weight_norm()
            label = f"stage5_lite_ckpt (step {ck.get('step', '?')})"
        else:
            p = self.train_root / "runs" / "m27_v1" / "neural_synth" / "best.pt"
            ck = torch.load(p, map_location=self.device, weights_only=False)
            gen = ConditionalHiFiGenerator27.from_arch_config(ck.get("generator_config")).to(self.device).eval()
            gen.load_state_dict(ck["generator"])
            gen.remove_weight_norm()
            label = f"stage5_teacher (step {ck.get('step', '?')})"

        self._stage5_models[synth_id] = (gen, label)
        return gen, label

    def decode_audio_16k(self, wav_bytes_or_path: Path | bytes, max_sec: float = 15.0) -> np.ndarray:
        import io
        from tt3.inference import extract_speech_mono

        if isinstance(wav_bytes_or_path, (bytes, bytearray)):
            data, sr = sf.read(io.BytesIO(wav_bytes_or_path), dtype="float32", always_2d=False)
        else:
            data, sr = sf.read(str(wav_bytes_or_path), dtype="float32", always_2d=False)
        audio = extract_speech_mono(np.asarray(data, dtype=np.float32), int(sr))
        if int(sr) != SAMPLE_RATE_16K:
            g = gcd(int(sr), SAMPLE_RATE_16K)
            audio = resample_poly(audio, SAMPLE_RATE_16K // g, int(sr) // g).astype(np.float32)
        max_samp = int(round(max_sec * SAMPLE_RATE_16K))
        if len(audio) > max_samp:
            audio = audio[:max_samp]
        n_frames = max(1, len(audio) // HOP_SAMPLES)
        return np.ascontiguousarray(audio[: n_frames * HOP_SAMPLES], dtype=np.float32)

    @torch.inference_mode()
    def analyze_audio(self, wav_bytes_or_path: Path | bytes, *, clip_id: str, name: str) -> AnalyzedClip:
        """Invert mono 16 kHz audio to 50 Hz M27 controls and a speaker embedding on the selected device."""
        with self._lock:
            t0 = time.perf_counter()
            wav_16k = self.decode_audio_16k(wav_bytes_or_path)
            n_frames = len(wav_16k) // HOP_SAMPLES
            pitch = self._get_pitch()
            inv = self._get_inverter()
            spk_enc = self._get_spk_encoder()

            from tt3.m27_contract import assemble_m27_norm, normalize_f0_m27

            f0_hz, voiced = pitch.extract_50hz(wav_16k, num_frames=n_frames)
            f0_norm = normalize_f0_m27(f0_hz)

            wav_t = torch.from_numpy(wav_16k).unsqueeze(0).to(self.device)
            f0_t = torch.from_numpy(f0_norm).view(1, n_frames, 1).to(self.device)
            mask_t = torch.ones((1, n_frames), dtype=torch.float32, device=self.device)
            vs_t = torch.tensor([len(wav_16k)], dtype=torch.long, device=self.device)

            tr, pr, gl = inv(wav_t, f0_t, mask_t)
            m27_norm = assemble_m27_norm(tr, f0_t, pr, gl).squeeze(0).cpu().numpy().astype(np.float32)
            m27_phys = denormalize_m27_norm(m27_norm)
            spk_emb = spk_enc(wav_t, vs_t).squeeze(0).cpu().numpy().astype(np.float32)
            voiced_f = np.asarray(voiced, dtype=np.float32).reshape(-1)[:n_frames]
            voiced_gate, speech_gate = compute_voicing_and_speech_gates(m27_phys, f0_voiced=voiced_f)
            invert_ms = (time.perf_counter() - t0) * 1000.0

            return AnalyzedClip(
                clip_id=clip_id,
                name=name,
                wav_16k=wav_16k,
                m27_norm=m27_norm,
                m27_phys=m27_phys,
                f0_voiced=voiced_f,
                voiced_gate=voiced_gate,
                speech_gate=speech_gate,
                spk_emb=spk_emb,
                dur_sec=len(wav_16k) / float(SAMPLE_RATE_16K),
                n_frames=n_frames,
                invert_ms=invert_ms,
            )

    def synthesize(
        self,
        m27_norm: np.ndarray,
        *,
        spk_seq: Optional[np.ndarray] = None,
        synth_id: str = "auto",
    ) -> Tuple[np.ndarray, int, str, float]:
        """Synthesize audio from 50 Hz `m27_norm` (+ optional `(T, 512)` or `(512,)` speaker embedding)."""
        with self._lock:
            t0 = time.perf_counter()
            if synth_id == "r21_physical":
                from tt3.glottis27_generator import M27Synthesizer

                m27_phys = denormalize_m27_norm(m27_norm)
                n50 = m27_phys.shape[0]
                n200 = n50 * 4
                t50 = (np.arange(n50, dtype=np.float64) + 0.5) / 50.0
                t200 = (np.arange(n200, dtype=np.float64) + 0.5) / 200.0
                m200 = np.empty((n200, 27), dtype=np.float64)
                for col in range(27):
                    m200[:, col] = np.interp(t200, t50, m27_phys[:, col])
                with M27Synthesizer(section_count=65) as r21:
                    res = r21.synthesize_200hz(m200, perturb_seed=20261123, tube_hz=100, return_48k=True)
                if res is None or res[0] is None:
                    raise RuntimeError("R21 物理合成失败")
                wav_48k = _normalize_playback(res[0])
                return wav_48k, SAMPLE_RATE_48K, "M10 R21 物理声管 (48 kHz)", (time.perf_counter() - t0) * 1000.0

            gen, label = self._get_stage5_generator(synth_id)
            n_frames = m27_norm.shape[0]
            if spk_seq is None:
                e = np.zeros((1, n_frames, 512), dtype=np.float32)
                e[..., 0] = 1.0
            else:
                arr = np.asarray(spk_seq, dtype=np.float32)
                if arr.ndim == 1:
                    e = np.repeat(arr.reshape(1, 1, -1), n_frames, axis=1)
                else:
                    e = arr[None, :n_frames, :]

            m_t = torch.from_numpy(np.asarray(m27_norm, dtype=np.float32)).unsqueeze(0).to(self.device)
            s_t = torch.from_numpy(e).to(self.device)
            wav_16k = synthesize_stage5_timevarying(gen, m_t, s_t).squeeze(0).cpu().numpy()
            wav_16k = _normalize_playback(wav_16k)
            return wav_16k, SAMPLE_RATE_16K, label, (time.perf_counter() - t0) * 1000.0

    def render_preset_morph(
        self,
        clip: AnalyzedClip,
        config: PresetMorphConfig,
        *,
        synth_id: str = "auto",
    ) -> Dict[str, Any]:
        presets = self.preset_store.load_all()
        p_dict = presets.get(config.preset_id)
        if p_dict is None:
            raise KeyError(f"未找到发声类型预设: {config.preset_id}")
        res = apply_preset_phonation_morph(
            clip.m27_norm,
            config,
            preset_dict=p_dict,
            f0_voiced=clip.f0_voiced,
        )
        wav, sr, synth_label, synth_ms = self.synthesize(
            res["m27_norm"],
            spk_seq=clip.spk_emb,
            synth_id=synth_id,
        )
        return {**res, "wav": wav, "sr": sr, "synth_label": synth_label, "synth_ms": round(synth_ms, 1)}

    def render_dual_morph(
        self,
        clip_a: AnalyzedClip,
        clip_b: AnalyzedClip,
        config: DualMorphConfig,
        *,
        synth_id: str = "auto",
    ) -> Dict[str, Any]:
        res = apply_dual_speaker_morph(
            clip_a.m27_norm,
            clip_b.m27_norm,
            config,
            spk_emb_a=clip_a.spk_emb,
            spk_emb_b=clip_b.spk_emb,
            f0_voiced_a=clip_a.f0_voiced,
            f0_voiced_b=clip_b.f0_voiced,
        )
        wav, sr, synth_label, synth_ms = self.synthesize(
            res["m27_norm"],
            spk_seq=res["spk_seq"],
            synth_id=synth_id,
        )
        return {**res, "wav": wav, "sr": sr, "synth_label": synth_label, "synth_ms": round(synth_ms, 1)}

    def list_demo_samples(self) -> List[Dict[str, str]]:
        clean_dir = Path(__file__).resolve().parent.parent.parent / "assets" / "demos"
        candidates = [
            ("zh_esd_f01_drive", "普通话同句 · 女01中性（我们可以轮流开车）", self.train_root / "data" / "emotion_esd" / "0001" / "neutral" / "000745_clip_000745.wav"),
            ("zh_esd_m04_drive", "普通话同句 · 男04中性（我们可以轮流开车）", self.train_root / "data" / "emotion_esd" / "0004" / "neutral" / "005995_clip_005995.wav"),
            ("zh_esd_f03_cute_neu", "普通话同句 · 女03中性（很可爱啊，就像你一样）", self.train_root / "data" / "emotion_esd" / "0003" / "neutral" / "004228_clip_004228.wav"),
            ("zh_esd_m06_cute_sad", "普通话同句 · 男06悲伤（很可爱啊，就像你一样）", self.train_root / "data" / "emotion_esd" / "0006" / "sadness" / "009828_clip_009828.wav"),
            ("zh_esd_f02_frog_neu", "普通话同句 · 女02中性（我是青蛙，不用冬眠的）", self.train_root / "data" / "emotion_esd" / "0002" / "neutral" / "002482_clip_002482.wav"),
            ("zh_esd_m08_frog_ang", "普通话同句 · 男08愤怒（我是青蛙，不用冬眠的）", self.train_root / "data" / "emotion_esd" / "0008" / "anger" / "012282_clip_012282.wav"),
            ("zh_esd_f02_ball_neu", "普通话同句 · 女02中性（递给我一些彩球和纸花）", self.train_root / "data" / "emotion_esd" / "0002" / "neutral" / "002498_clip_002498.wav"),
            ("zh_esd_m04_ball_neu", "普通话同句 · 男04中性（递给我一些彩球和纸花）", self.train_root / "data" / "emotion_esd" / "0004" / "neutral" / "005998_clip_005998.wav"),
            ("zh_esd_f03_wknd_neu", "同人对照 · 女03中性（周末的我，只忙着陪你）", self.train_root / "data" / "emotion_esd" / "0003" / "neutral" / "004212_clip_004212.wav"),
            ("zh_esd_f03_wknd_sad", "同人对照 · 女03悲伤（周末的我，只忙着陪你）", self.train_root / "data" / "emotion_esd" / "0003" / "sadness" / "004562_clip_004562.wav"),
            ("zh_mandarin_01", "普通话自然句 01 (KeSpeech)", self.train_root / "runs" / "eval_samples" / "zh_mandarin_01__ref.wav"),
            ("zh_mandarin_02", "普通话自然句 02 (KeSpeech)", self.train_root / "runs" / "eval_samples" / "zh_mandarin_02__ref.wav"),
            ("zh_tones_01", "普通话四声连读 (常态)", self.train_root / "runs" / "eval_samples" / "zh_tones_01__ref.wav"),
            ("en_test_01", "英语自然句 (LibriSpeech)", self.train_root / "runs" / "eval_samples" / "en_test_01__ref.wav"),
            ("vq_breathy", "四声 · 气声参考 (Breathy)", self.train_root / "runs" / "phonation_demo" / "zh_tones_01__breathy.wav"),
            ("vq_pressed", "四声 · 挤喉发声/紧声参考 (Pressed)", self.train_root / "runs" / "phonation_demo" / "zh_tones_01__pressed.wav"),
            ("vq_creaky", "四声 · 嘎裂参考 (Creaky)", self.train_root / "runs" / "phonation_demo" / "zh_tones_01__creaky.wav"),
            ("vq_falsetto", "四声 · 假声参考 (Falsetto)", self.train_root / "runs" / "phonation_demo" / "zh_tones_01__falsetto.wav"),
        ]
        out: List[Dict[str, str]] = []
        for cid, lbl, fallback in candidates:
            clean_p = clean_dir / f"{cid}.wav"
            chosen = clean_p if clean_p.is_file() else fallback
            if chosen.is_file():
                out.append({"id": cid, "label": lbl, "path": str(chosen)})
        return out
