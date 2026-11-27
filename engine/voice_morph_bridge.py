"""Zero-PyTorch ONNX bridge to M27 Voice Morph Studio (time-varying phonation & dual-speaker morphing)."""
from __future__ import annotations

from base64 import b64encode
from collections import OrderedDict
from dataclasses import dataclass, field
from io import BytesIO
import json
from math import gcd
from pathlib import Path
from threading import Lock
import time
from typing import Any, Dict, List, Optional, Tuple
from uuid import uuid4

import numpy as np
from scipy.signal import resample_poly
import soundfile as sf

from dense_channel import apply_synthesis_gain, pcm_float_to_wav_bytes
from keyframe_lite import AnnotationControlError
from m27_bridge import M27Bridge
from model_registry_runtime import LOCAL_MODEL_MANAGER, ModelUnloadedError, ort_cuda_available
import onnx_frontends as ofr
from onnx_inference import (
    ensure_pure_numpy_imports,
    extract_speaker_embedding,
    extract_swift_f0_50hz,
    run_vox2tract_chunk,
    synthesize_tract2vox,
)
from validation import decode_base64_payload, is_finite_number, validate_m27_pa, validate_scalar_range, validation_error

GROUPS = {"speaker", "tract_all", "glottis", "f0_pr"}
MAX_FRAMES = 750
MAX_ANALYZED_CLIPS = 12
SYNTHESIZERS = {"neural": "Tract2Vox-Lite 神经合成", "physical": "VTL 2.4 物理合成"}


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
    baseline_cache: Dict[Tuple[str, str, str], Tuple[bytes, int]] = field(default_factory=dict)

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


class VoiceMorphBridge:
    def __init__(self, native_engine: M27Bridge):
        self.native_engine = native_engine
        self.voqs_profiles = None
        self.clips: OrderedDict[str, AnalyzedClip] = OrderedDict()
        self.lock = Lock()
        self._preset_store = None

    def _get_preset_store(self):
        if self._preset_store is None:
            ensure_pure_numpy_imports()
            from m27_voice_morph.presets import CustomPresetStore

            work = Path(__file__).resolve().parents[1] / ".cache" / "voice-morph"
            work.mkdir(parents=True, exist_ok=True)
            self._preset_store = CustomPresetStore(work / "presets.json")
        return self._preset_store

    def _presets(self):
        return self._get_preset_store().load_all()

    @staticmethod
    def _public_preset(preset):
        out = {key: preset.get(key) for key in (
            "id", "label", "desc", "f0_shift_semitones", "f0_target_hz", "default_f0_coupling",
            "is_voiceless_target", "larynx_hy_delta_cm", "supports_creak_irregularity",
            "default_creak_irregularity", "supports_diplophonia", "default_diplophonia_mode",
            "default_diplophonia_ratio", "experimental", "builtin",
        )}
        raw_src9 = preset.get("source9_phys")
        if isinstance(raw_src9, (list, tuple)) and len(raw_src9) == 9:
            # Convert internal dPa -> public Pa strictly at the Python engine boundary.
            pr_pa = round(float(raw_src9[0]) / 10.0, 2)
            tail = [round(float(x), 5) for x in raw_src9[1:]]
            out["source9_phys_pa"] = [pr_pa, *tail]
            out["source_params"] = {
                "pr_pa": pr_pa,
                "xb_cm": tail[0],
                "xt_cm": tail[1],
                "ca_cm2": tail[2],
                "lag_rad": tail[3],
                "ra": tail[4],
                "ps": tail[5],
                "fl_pct": tail[6],
                "shim_pct": tail[7],
            }
        return out

    @staticmethod
    def _decode_audio_16k(wav_bytes: bytes, max_sec: float = 15.0) -> np.ndarray:
        data, sr = sf.read(BytesIO(wav_bytes), dtype="float32", always_2d=False)
        audio = ofr.extract_speech_mono(np.asarray(data, dtype=np.float32), int(sr))
        if int(sr) != ofr.SAMPLE_RATE_16K:
            g = gcd(int(sr), ofr.SAMPLE_RATE_16K)
            audio = resample_poly(audio, ofr.SAMPLE_RATE_16K // g, int(sr) // g).astype(np.float32)
        max_samp = int(round(max_sec * ofr.SAMPLE_RATE_16K))
        if len(audio) > max_samp:
            audio = audio[:max_samp]
        n_frames = max(1, len(audio) // ofr.HOP_SAMPLES_16K)
        return np.ascontiguousarray(audio[: n_frames * ofr.HOP_SAMPLES_16K], dtype=np.float32)

    def metadata(self):
        with self.lock:
            ensure_pure_numpy_imports()
            from m27_voice_morph.presets import ORGAN_GROUPS

            for model_name in ("Vox2Tract-Lite", "Vox2Spk-Lite"):
                if not LOCAL_MODEL_MANAGER.active_path(model_name).is_file():
                    raise FileNotFoundError(f"项目模型包缺少 {model_name} 权重")
            synthesizers = [{"id": "physical", "label": SYNTHESIZERS["physical"]}]
            if LOCAL_MODEL_MANAGER.is_enabled("Tract2Vox-Lite") and LOCAL_MODEL_MANAGER.active_path("Tract2Vox-Lite").is_file():
                synthesizers.insert(0, {"id": "neural", "label": SYNTHESIZERS["neural"]})
            presets = self._presets()
            return {
                "ok": True,
                "presets": [self._public_preset(p) for p in presets.values()],
                "groups": [
                    {key: g.get(key) for key in ("id", "label", "desc", "recommended_delta", "coupling_note", "is_speaker", "is_timing", "requires_alignment")}
                    for g in ORGAN_GROUPS.values()
                ],
                "model_source": "project_bundle",
                "synthesizers": synthesizers,
                "cuda_available": ort_cuda_available(),
            }

    def _analyze(self, serialized, name, *, device="cpu") -> AnalyzedClip:
        if error := self.native_engine._validate_requested_device(device):
            raise AnnotationControlError(error)
        wav = decode_base64_payload(serialized, field=f"{name}.wav_base64", max_bytes=8 * 1024 * 1024)
        try:
            if not 0.04 <= sf.info(BytesIO(wav)).duration <= 15:
                raise ValueError(f"{name}片段时长须为 0.04–15 秒")
        except sf.LibsndfileError as error:
            raise ValueError(f"{name}片段的音频格式无效") from error

        ensure_pure_numpy_imports()
        from kf_ipa_synth.m27_contract import denormalize_m27, normalize_f0_m27
        from m27_voice_morph.curves import compute_voicing_and_speech_gates

        t0 = time.perf_counter()
        wav_16k = self._decode_audio_16k(wav)
        n_frames = len(wav_16k) // ofr.HOP_SAMPLES_16K
        if not 2 <= n_frames <= MAX_FRAMES:
            raise ValueError(f"{name}音频帧数不在可处理范围内")

        f0_hz, voiced = extract_swift_f0_50hz(wav_16k, fmin=46.875, fmax=2093.75, num_frames=n_frames)
        f0_norm = normalize_f0_m27(f0_hz)
        tr, pr, gl, _, _, _ = run_vox2tract_chunk(wav_16k, f0_norm, device=device)
        m27_norm = np.concatenate([tr[0], f0_norm[:, None], pr[0], gl[0]], axis=-1).astype(np.float32)
        m27_phys = denormalize_m27(m27_norm)
        spk_emb, _ = extract_speaker_embedding(wav_16k, device=device)
        voiced_f = np.asarray(voiced, dtype=np.float32).reshape(-1)[:n_frames]
        voiced_gate, speech_gate = compute_voicing_and_speech_gates(m27_phys, f0_voiced=voiced_f)
        invert_ms = (time.perf_counter() - t0) * 1000.0

        return AnalyzedClip(
            clip_id=uuid4().hex,
            name=name,
            wav_16k=wav_16k,
            m27_norm=m27_norm,
            m27_phys=m27_phys,
            f0_voiced=voiced_f,
            voiced_gate=voiced_gate,
            speech_gate=speech_gate,
            spk_emb=spk_emb,
            dur_sec=len(wav_16k) / float(ofr.SAMPLE_RATE_16K),
            n_frames=n_frames,
            invert_ms=invert_ms,
        )

    def _clip(self, data, key) -> AnalyzedClip:
        clip_id = data.get(key)
        if not isinstance(clip_id, str) or clip_id not in self.clips:
            raise ValueError("录音分析已失效，请重新分析音频。")
        self.clips.move_to_end(clip_id)
        return self.clips[clip_id]

    @staticmethod
    def _knots(knots, name):
        if not isinstance(knots, list) or not 2 <= len(knots) <= 50:
            raise ValueError(f"{name}曲线须包含 2–50 个节点")
        for i, knot in enumerate(knots):
            if not isinstance(knot, dict):
                raise ValueError(f"{name}曲线节点格式无效")
            for key in ("t", "v"):
                err = validate_scalar_range(f"{name}[{i}].{key}", knot.get(key), 0, 1, "ratio", tol=0)
                if err:
                    raise AnnotationControlError(err)
        if any(a["t"] >= b["t"] for a, b in zip(knots, knots[1:])):
            raise ValueError(f"{name}曲线节点时间须严格递增")
        return knots

    def _synthesize_neural_onnx(self, m27_norm: np.ndarray, spk_seq: Optional[np.ndarray], device: str) -> Tuple[np.ndarray, int]:
        n_frames = m27_norm.shape[0]
        if spk_seq is None:
            e = np.zeros((n_frames, 512), dtype=np.float32)
            e[:, 0] = 1.0
        else:
            e = np.asarray(spk_seq, dtype=np.float32)
        with self.native_engine._vocoder_lock:
            wav_16k, _ = synthesize_tract2vox(m27_norm, e, device=device)
        return _normalize_playback(wav_16k), ofr.SAMPLE_RATE_16K

    def _synthesize_baseline_cached(
        self, clip: AnalyzedClip, synth: str, device: str, audio_gain: str
    ) -> Tuple[bytes, int]:
        eff_dev = device if synth == "neural" else "cpu"
        key = (synth, eff_dev, str(audio_gain))
        cached = clip.baseline_cache.get(key)
        if cached is not None:
            return cached
        if synth == "neural":
            if error := self.native_engine._validate_requested_device(device):
                raise AnnotationControlError(error)
            wav, rate = self._synthesize_neural_onnx(clip.m27_norm, clip.spk_emb, device)
            wav_bytes = pcm_float_to_wav_bytes(apply_synthesis_gain(wav, audio_gain), rate)
        else:
            wav_bytes = self.native_engine._synthesize_vtl_from_m27(clip.m27_phys, audio_gain=audio_gain)
            rate = 48_000
        clip.baseline_cache[key] = (wav_bytes, rate)
        return wav_bytes, rate

    def dispatch(self, data):
        if not isinstance(data, dict):
            raise ValueError("发声调音台请求须为 JSON 对象")
        device = data.get("device", "cpu")
        if device not in ("cpu", "cuda"):
            raise AnnotationControlError(validation_error("device", "请选择本地 CPU 或 CUDA GPU"))
        with self.lock:
            action = data.get("action")
            if action == "analyze":
                clip = self._analyze(data.get("wav_base64"), "待分析", device=device)
                self.clips[clip.clip_id] = clip
                if len(self.clips) > MAX_ANALYZED_CLIPS:
                    self.clips.popitem(last=False)
                return {"ok": True, **clip.to_public_meta(), "device_effective": device}
            if action == "delete_preset":
                preset_id = data.get("preset_id")
                if not isinstance(preset_id, str) or not preset_id.strip():
                    raise ValueError("请指定要删除的自定义发声类型预设")
                deleted = self._get_preset_store().delete_custom(preset_id.strip())
                if not deleted:
                    raise ValueError("仅可删除已保存的自定义发声类型预设")
                return {"ok": True, "deleted_id": preset_id.strip()}
            if action not in ("extract_preset", "render_preset", "render_dual", "render_baseline"):
                raise ValueError("请选择发声调音台操作")

            clip = self._clip(data, "clip_id")
            if action == "render_baseline":
                synth = data.get("synth", "neural")
                if synth not in ("neural", "physical"):
                    raise ValueError("合成音源无效")
                gain = data.get("audio_gain", "peak")
                wav_bytes, rate = self._synthesize_baseline_cached(clip, synth, device, gain)
                return {
                    "ok": True,
                    "baseline_audio_base64": b64encode(wav_bytes).decode("ascii"),
                    "baseline_rate_hz": rate,
                    "label": SYNTHESIZERS[synth],
                    "device_effective": device if synth == "neural" else "cpu",
                }
            if action == "extract_preset":
                ensure_pure_numpy_imports()
                from m27_voice_morph.presets import extract_phonation_preset_from_m27_phys

                label = data.get("label")
                if not isinstance(label, str) or not 1 <= len(label.strip()) <= 40:
                    raise ValueError("请填写 1–40 字的预设名称")
                voiced = clip.voiced_gate > 0.5
                active_mask = voiced if np.any(voiced) else (clip.speech_gate > 0.5)
                if not np.any(active_mask):
                    raise ValueError("未找到可提取发声类型的有效语音帧")
                extracted = extract_phonation_preset_from_m27_phys(
                    clip.m27_phys,
                    voiced_mask=active_mask,
                    center_fraction=0.4,
                )
                extracted.pop("frames_used")
                entry = self._get_preset_store().save_custom(uuid4().hex, label=label.strip(), **extracted)
                return {"ok": True, "preset": self._public_preset(entry)}
            ensure_pure_numpy_imports()
            from m27_voice_morph.curves import F0ShiftOutOfRange

            try:
                return self._render_mixer(data, action, clip, device)
            except F0ShiftOutOfRange as error:
                err = validate_scalar_range("f0_hz", error.hz, 40, 600, "Hz", tol=0)
                if err:
                    err["error"]["hint"] = f"f0_hz ({error.hz:.1f} Hz) 超出 VTL 2.4 物理声门原生范围 [40, 600] Hz；请切换 Tract2Vox-Lite 神经合成或调整移调"
                raise AnnotationControlError(err) from error

    def _render_mixer(self, data, action, clip, device):
        ensure_pure_numpy_imports()
        from m27_voice_morph.morpher import (
            DIPLOPHONIA_MODES,
            DualMorphConfig,
            PresetMorphConfig,
            apply_dual_speaker_morph,
            apply_preset_phonation_morph,
            apply_subharmonic_creaky_falsetto,
            apply_voiced_falsetto_softening,
            mix_diplophonia_audio,
        )
        from m27_voice_morph.presets import ORGAN_GROUPS

        interp = data.get("interp_mode", "smoothstep")
        synth = data.get("synth", "neural")
        smooth = data.get("smooth_ms", 25)
        gate = data.get("voicing_gate", True)
        f0 = data.get("f0_coupling", False)
        if interp not in ("linear", "smoothstep") or synth not in ("neural", "physical"):
            raise ValueError("插值方式或合成音源无效")
        if not isinstance(gate, bool) or not isinstance(f0, bool):
            raise ValueError("门控与 F0 联动开关须为布尔值")
        if err := validate_scalar_range("smooth_ms", smooth, 0, 80, "ms", tol=0):
            raise AnnotationControlError(err)
        options = dict(interp_mode=interp, smooth_ms=smooth, enable_voicing_gate=gate, enable_f0_coupling=f0,
                       output_f0_range_hz=(40.0, 600.0) if synth == "physical" else None)
        if action == "render_preset":
            preset_id = data.get("preset_id")
            preset = self._presets().get(preset_id) if isinstance(preset_id, str) else None
            if preset is None:
                raise ValueError("请选择可用的发声类型预设")
            shift = data.get("f0_shift_semitones")
            if shift is not None and (err := validate_scalar_range("f0_shift_semitones", shift, -12, 12, "st", tol=0)):
                raise AnnotationControlError(err)
            default_irreg = preset.get("default_creak_irregularity", 0.30)
            creak_irreg = data.get("creak_irregularity", default_irreg)
            if err := validate_scalar_range("creak_irregularity", creak_irreg, 0, 1, "ratio", tol=0):
                raise AnnotationControlError(err)
            dip_mode = data.get("diplophonia_mode", preset.get("default_diplophonia_mode", "parallel"))
            if dip_mode not in DIPLOPHONIA_MODES:
                raise ValueError("双音调耦合机制无效，须为 parallel、ventricular 或 vertical")
            default_dip_ratio = preset.get("default_diplophonia_ratio", DIPLOPHONIA_MODES[dip_mode]["default_ratio"])
            dip_ratio = data.get("diplophonia_ratio", default_dip_ratio)
            if err := validate_scalar_range("diplophonia_ratio", dip_ratio, 0.35, 2.00, "ratio", tol=0):
                raise AnnotationControlError(err)
            if "f0_coupling" not in data and preset.get("default_f0_coupling"):
                options["enable_f0_coupling"] = True
            config = PresetMorphConfig(
                preset_id=preset_id,
                knots=self._knots(data.get("knots"), "发声类型"),
                f0_shift_semitones=shift,
                creak_irregularity=float(creak_irreg),
                diplophonia_mode=str(dip_mode),
                diplophonia_ratio=float(dip_ratio),
                **options,
            )
            result = apply_preset_phonation_morph(clip.m27_norm, config, preset_dict=preset, f0_voiced=clip.f0_voiced)
            speakers = clip.spk_emb
            extra = {"applied_curves": {"preset": result["w_eff"].tolist()}, "f0_shift_st": result["applied_semitones"]}
            if result["f0_target_hz"] is not None:
                extra["f0_target_hz"] = result["f0_target_hz"]
            if result.get("diplophonia") is not None:
                extra["diplophonia_mode"] = result["diplophonia"]["mode"]
                extra["diplophonia_ratio"] = result["diplophonia"]["ratio"]
        else:
            source = self._clip(data, "source_id")
            curves = data.get("curves")
            if not isinstance(curves, dict) or not curves.keys() <= ORGAN_GROUPS.keys() or not curves:
                raise ValueError("请选择至少一项可混合的声音属性")
            for group, knots in curves.items():
                self._knots(knots, group)
            if synth == "physical" and "speaker" in curves:
                raise ValueError("音色轨需要 Tract2Vox-Lite")
            delta = data.get("delta_groups", [])
            if not isinstance(delta, list) or any(g not in ORGAN_GROUPS or g in ("speaker", "timing") or g not in curves for g in delta):
                raise ValueError("相对偏移仅可用于已启用的声道或发声轨")
            anchors = self._mixer_anchors(data.get("anchors", []), clip.dur_sec, source.dur_sec)
            timing_engaged = any(float(k.get("v", 0)) > 0.005 for k in curves.get("timing", []))
            if timing_engaged and not anchors:
                raise ValueError("启用「时长与韵律」轨前，请先为说话人 A 与 B 完成文字或音节标注对齐")
            config = DualMorphConfig(align_mode="anchors" if anchors else "dtw", anchors_sec=anchors,
                                     group_curves=curves, delta_groups=delta, **options)
            result = apply_dual_speaker_morph(clip.m27_norm, source.m27_norm, config, spk_emb_a=clip.spk_emb,
                                              spk_emb_b=source.spk_emb, f0_voiced_a=clip.f0_voiced,
                                              f0_voiced_b=source.f0_voiced)
            speakers = result["spk_seq"]
            extra = {
                "applied_curves": {group: result["applied_curves"][group].tolist() for group in curves},
                "f0_shift_st": result["auto_f0_shift_semitones"],
                "out_dur_sec": result.get("out_dur_sec"),
                "align_mode": "textgrid" if anchors else "dtw",
                "align_info": result.get("align_info"),
            }

        gain = data.get("audio_gain", "peak")
        t_synth = time.perf_counter()
        dip = result.get("diplophonia")
        dip_active = dip is not None and float(np.max(dip["mix_curve_50hz"])) > 1e-4
        audio_post = result.get("audio_post") or {}
        has_post = bool(audio_post) and float(np.max(result["w_eff"])) > 1e-4

        def _apply_post_fx(wav_arr: np.ndarray, sample_rate: int, synth_mode: str) -> np.ndarray:
            out_w = wav_arr
            if "soft_falsetto" in audio_post:
                out_w = apply_voiced_falsetto_softening(out_w, result["w_eff"], sample_rate, **audio_post["soft_falsetto"])
            if "subharmonic_creak" in audio_post:
                out_w = apply_subharmonic_creaky_falsetto(
                    out_w, result["f0_after_hz"], result["w_eff"], sample_rate, **audio_post["subharmonic_creak"]
                )
            air_spec = audio_post.get("whisper_air")
            if air_spec is not None and float(np.max(air_spec["mix_curve_50hz"])) > 1e-4:
                if synth_mode == "neural":
                    wav_air, _ = self._synthesize_neural_onnx(air_spec["m27_whisper_norm"], speakers, device)
                else:
                    air_bytes = self.native_engine._synthesize_vtl_from_m27(air_spec["m27_whisper_phys"], audio_gain="raw")
                    wav_air, _ = sf.read(BytesIO(air_bytes), dtype="float32")
                out_w = mix_diplophonia_audio(
                    out_w,
                    wav_air,
                    air_spec["mix_curve_50hz"],
                    result["f0_after_hz"],
                    sample_rate,
                    ratio_b_max=air_spec["ratio_b_max"],
                    am_depth_max=0.0,
                )
            return out_w

        if synth == "neural":
            if error := self.native_engine._validate_requested_device(device):
                raise AnnotationControlError(error)
            wav, rate = self._synthesize_neural_onnx(result["m27_norm"], speakers, device)
            if dip_active:
                wav_b, _ = self._synthesize_neural_onnx(dip["m27_secondary_norm"], speakers, device)
                wav = mix_diplophonia_audio(
                    wav,
                    wav_b,
                    dip["mix_curve_50hz"],
                    dip["f_b_50hz"],
                    rate,
                    ratio_b_max=dip["ratio_b_max"],
                    am_depth_max=dip["am_depth_max"],
                )
            if has_post:
                wav = _apply_post_fx(wav, rate, "neural")
            wav_bytes = pcm_float_to_wav_bytes(apply_synthesis_gain(wav, gain), rate)
            eff_device = device
        else:
            if dip_active or has_post:
                bytes_a = self.native_engine._synthesize_vtl_from_m27(result["m27_phys"], audio_gain="raw")
                wav_a, rate_a = sf.read(BytesIO(bytes_a), dtype="float32")
                out_p = wav_a
                if dip_active:
                    bytes_b = self.native_engine._synthesize_vtl_from_m27(dip["m27_secondary_phys"], audio_gain="raw")
                    wav_b, _ = sf.read(BytesIO(bytes_b), dtype="float32")
                    out_p = mix_diplophonia_audio(
                        out_p,
                        wav_b,
                        dip["mix_curve_50hz"],
                        dip["f_b_50hz"],
                        int(rate_a),
                        ratio_b_max=dip["ratio_b_max"],
                        am_depth_max=dip["am_depth_max"],
                    )
                if has_post:
                    out_p = _apply_post_fx(out_p, int(rate_a), "physical")
                wav_bytes = pcm_float_to_wav_bytes(apply_synthesis_gain(out_p, gain), int(rate_a))
                rate = int(rate_a)
            else:
                wav_bytes = self.native_engine._synthesize_vtl_from_m27(result["m27_phys"], audio_gain=gain)
                rate = 48_000
            eff_device = "cpu"
        if bool(data.get("include_baseline")):
            base_bytes, base_rate = self._synthesize_baseline_cached(clip, synth, device, gain)
            extra["baseline_audio_base64"] = b64encode(base_bytes).decode("ascii")
            extra["baseline_rate_hz"] = base_rate
        synth_ms = round((time.perf_counter() - t_synth) * 1000.0, 1)
        return {
            "ok": True, "audio_base64": b64encode(wav_bytes).decode("ascii"),
            "rate_hz": rate, "label": SYNTHESIZERS[synth], "device_effective": eff_device, "synth_ms": synth_ms, **extra,
        }

    @staticmethod
    def _mixer_anchors(anchors, duration_a, duration_b):
        if not isinstance(anchors, list) or len(anchors) > 300:
            raise ValueError("TextGrid 对齐锚点格式无效或超过 300 个")
        previous = {"t_a": 0, "t_b": 0}
        for anchor in anchors:
            if not isinstance(anchor, dict) or not all(
                is_finite_number(anchor.get(key)) and previous[key] < anchor[key] < duration - 0.02
                for key, duration in (("t_a", duration_a), ("t_b", duration_b))
            ):
                raise ValueError("TextGrid 对齐锚点须在两段录音内分别严格递增")
            previous = anchor
        return anchors

    @staticmethod
    def _controls(value):
        if value is None:
            return None
        controls, err = validate_m27_pa(value, field="rows_pa", min_frames=2, max_frames=MAX_FRAMES)
        if err:
            raise AnnotationControlError(err)
        assert controls is not None
        return controls.astype(np.float32)

    def _operand(self, payload, name):
        ensure_pure_numpy_imports()
        from m27_voice_morph.morpher import normalize_m27_phys

        if not isinstance(payload, dict):
            raise ValueError(f"缺少{name}片段")
        controls = self._controls(payload.get("rows_pa"))
        serialized = payload.get("wav_base64")
        clip = None
        if serialized:
            clip = self._analyze(serialized, name)
        if controls is not None:
            physical = controls.copy()
            physical[:, 18] *= 10
            track = normalize_m27_phys(physical)
            voiced = None
        elif clip is not None:
            track, voiced = clip.m27_norm, clip.f0_voiced
        else:
            raise ValueError(f"{name}片段缺少音频或声道轨迹")
        return track, clip.spk_emb if clip else None, voiced

    def _voqs_source(self, take_id, target):
        ensure_pure_numpy_imports()
        from m27_voice_morph.morpher import denormalize_m27_norm, normalize_m27_phys

        if self.voqs_profiles is None:
            manifest = Path(__file__).resolve().parents[1] / "src" / "data" / "voqs-recordings.json"
            self.voqs_profiles = json.loads(manifest.read_text(encoding="utf-8"))
        for profile in self.voqs_profiles:
            for take in profile["takes"]:
                if take["id"] != take_id:
                    continue
                if profile["group"] == "height":
                    raise ValueError("喉位参照需要独立的喉位控制，当前 M27 迁移不支持这两项")
                glottis = take["glottis"]
                controls = denormalize_m27_norm(target)
                controls[:, 17] = glottis["f0_hz"]
                controls[:, 18] = glottis["pr_pa"] * 10
                controls[:, 19:] = [glottis[key] for key in ("xb_cm", "xt_cm", "ca_cm2", "lag_rad", "ra", "ps", "fl", "shim")]
                return normalize_m27_phys(controls)
        raise ValueError("请选择已有的 VoQS 参考实录")

    def render(self, data):
        with self.lock:
            ensure_pure_numpy_imports()
            from m27_voice_morph.alignment import align_m27_anchors, align_m27_dtw
            from m27_voice_morph.morpher import DualMorphConfig, apply_dual_speaker_morph

            curves = data.get("curves", {})
            if not isinstance(curves, dict) or set(curves) - GROUPS:
                raise ValueError("存在不支持的声音属性")
            for group, knots in curves.items():
                if not isinstance(knots, list) or len(knots) > 50 or any(
                    not isinstance(k, dict) or not all(isinstance(k.get(key), (float, int)) and 0 <= k[key] <= 1 for key in ("t", "v"))
                    for k in knots
                ):
                    raise ValueError(f"{group} 曲线的时间和权重须在 0–100%")
            rhythm = bool(data.get("rhythm"))
            if not rhythm and not any(k["v"] > 0 for knots in curves.values() for k in knots):
                raise ValueError("请至少启用一项迁移")
            a, emb_a, voiced_a = self._operand(data.get("target"), "目标")
            voqs = data.get("voqs_source_id")
            if voqs:
                if rhythm or set(curves) - {"glottis", "f0_pr"}:
                    raise ValueError("VoQS 来源支持声门和基频气压两项属性")
                b, emb_b, voiced_b = self._voqs_source(voqs, a), emb_a, voiced_a
            else:
                b, emb_b, voiced_b = self._operand(data.get("source"), "来源")
            if any(k["v"] > 0 for k in curves.get("speaker", [])) and (emb_a is None or emb_b is None):
                raise ValueError("音色过渡需要来源和目标的参考音频。轨迹可迁移节奏、声道和声门。")
            anchors = [{"t_a": 0, "t_b": 0}] if voqs else data.get("anchors") or []
            if not isinstance(anchors, list) or len(anchors) > 300:
                raise ValueError("对齐锚点过多或格式不正确")
            if any(not isinstance(k, dict) or not all(isinstance(k.get(key), (float, int)) and np.isfinite(k[key]) and k[key] >= 0 for key in ("t_a", "t_b")) for k in anchors):
                raise ValueError("对齐锚点时间无效")
            if any(right["t_a"] <= left["t_a"] or right["t_b"] <= left["t_b"] for left, right in zip(anchors, anchors[1:])):
                raise ValueError("对齐锚点须分别在两条轨迹上递增")
            mode = "anchors" if anchors else "dtw"
            target_map = np.arange(len(a))
            if rhythm:
                swapped = [{"t_a": k["t_b"], "t_b": k["t_a"]} for k in anchors]
                if swapped:
                    a, target_map, _ = align_m27_anchors(b, a, swapped)
                else:
                    a, target_map, _ = align_m27_dtw(b, a)
                if voiced_a is not None:
                    voiced_a = np.interp(target_map, np.arange(len(voiced_a)), voiced_a)
            config = DualMorphConfig(
                align_mode="anchors" if rhythm else mode,
                anchors_sec=[{"t_a": 0, "t_b": 0}] if rhythm else anchors,
                group_curves=curves, delta_groups=[],
                enable_voicing_gate=bool(data.get("voicing_gate", True)),
            )
            output = apply_dual_speaker_morph(
                a, b, config, spk_emb_a=emb_a, spk_emb_b=emb_b, f0_voiced_a=voiced_a, f0_voiced_b=voiced_b,
            )
            physical = output["m27_phys"].copy()
            if emb_a is not None:
                wav, rate = self._synthesize_neural_onnx(output["m27_norm"], output["spk_seq"], "cpu")
                label = "Tract2Vox-Lite ONNX"
                wav_bytes = pcm_float_to_wav_bytes(apply_synthesis_gain(wav, data.get("audio_gain", "peak")), rate)
            else:
                wav_bytes = self.native_engine._synthesize_vtl_from_m27(physical, audio_gain=data.get("audio_gain", "peak"))
                rate, label = 48_000, "VTL 2.4 物理声管 (48 kHz)"
            physical[:, 18] /= 10
            return {
                "ok": True,
                "audio_base64": b64encode(wav_bytes).decode("ascii"),
                "rate_hz": rate, "label": label,
                "rows_pa": physical.round(4).tolist(),
                "target_frame_map": target_map.round(4).tolist(),
                "align_mode": "voqs" if voqs else "textgrid" if anchors else "dtw",
                "applied_curves": {group: samples.tolist() for group, samples in output["applied_curves"].items()},
            }
