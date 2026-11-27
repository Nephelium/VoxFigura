"""Local VoxFigura Core (Vox2Tract / Tract2Vox / Vox2Align / Vox2Spk) pure-ONNX inference and 48 kHz adapters."""
from __future__ import annotations

import base64
from collections import OrderedDict
import hashlib
from pathlib import Path
import sys
import tempfile
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

from audio_transitions import finish_synthesis
from dense_channel import (
    DenseEngineManager,
    VTL_NATIVE_DIR,
    VTL_NATIVE_ROOT,
    apply_synthesis_gain,
    pcm_float_to_wav_bytes,
)
from ipa_articulation import preserve_stop_transients
from model_registry_runtime import LOCAL_MODEL_MANAGER, ModelUnloadedError, ort_cuda_available
import onnx_frontends as ofr
from onnx_inference import (
    analyze_waveform_onnx,
    ensure_pure_numpy_imports,
    extract_speaker_embedding,
    load_speaker_profile_embedding,
    synthesize_tract2vox,
)
from trills import apply_trill_to_m27, resolve_trill_place
from validation import (
    CONTROL_TOL,
    decode_base64_payload,
    out_of_range_error,
    validate_glottis_frames,
    validate_m27_pa,
    validate_positive_series,
    validate_scalar_range,
    validate_scalar_series,
    validate_shape_frames,
    validate_tract19_frames,
    validation_error,
)

TT3_ROOT = Path(__file__).resolve().parent / "model_bundle"
TT3_SRC = TT3_ROOT / "src"
DEFAULT_VOICE_ID = "jingjing-lecture"
DEFAULT_TIMBRE_PROFILE = TT3_ROOT / "speakers" / "jingjing-lecture.spk.json"
VOX2ALIGN_LABEL = "Vox2Align-Lite v2"
MAX_INPUT_DURATION_S = 60.0

CONTROL_HZ_50 = 50
CONTROL_HZ_200 = 200

# PTB/VTL geometry extras that the 27-dim M27 control (and therefore Tract2Vox-Lite) has no channel for.
STAGE5_GEOMETRY_EXTRAS = (
    "lip_width_frames",
    "larynx_height_frames",
    "manual_root",
    "manual_root_frames",
    "tongue_shape",
    "lip_shape",
    "tongue_shape_frames",
    "lip_shape_frames",
)


def stage5_geometry_extras(payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    """List non-default geometry extras (field and first frame) that M27 cannot represent."""
    found: List[Dict[str, Any]] = []
    for field in STAGE5_GEOMETRY_EXTRAS:
        if field not in payload or payload[field] is None:
            continue
        default = 1.0 if field == "lip_width_frames" else 0.0
        try:
            values = np.asarray(payload[field], dtype=np.float64)
        except (TypeError, ValueError):
            found.append({"field": field, "frame": None})
            continue
        rows = values.reshape(len(values), -1) if values.ndim >= 1 and len(values) else values.reshape(1, -1)
        bad = np.flatnonzero(~np.isclose(rows, default, atol=1e-7).all(axis=1))
        if bad.size:
            found.append({"field": field, "frame": int(bad[0]) if values.ndim >= 1 and field.endswith("_frames") else None})
    return found


SAMPLE_RATE_16K = 16000
SAMPLE_RATE_48K = 48000
WAVLM_HOP_SAMPLES = 320
SAMPLES_PER_FRAME_48K = 960

PARTS_ORDER = (
    "upper_cover",
    "lower_cover",
    "upper_teeth",
    "lower_teeth",
    "upper_lip",
    "lower_lip",
    "tongue",
    "uvula",
    "epiglottis",
)

_TRACT_17_TO_19_IDX = np.array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 16, 17, 18], dtype=np.int64)
_M27_TRACT17_MIN = np.array(
    [0.0, -6.0, -0.5, -7.0, -1.0, -2.0, 0.0, -0.1, -3.0, -3.0, 1.5, -3.0, -3.0, -3.0, 0.0, 0.0, -1.0],
    dtype=np.float64,
)
_M27_TRACT17_MAX = np.array(
    [1.0, -3.5, 0.0, 0.0, 1.0, 4.0, 1.0, 1.5, 4.0, 1.0, 7.5, 2.5, 6.5, 5.0, 1.0, 1.0, 1.0],
    dtype=np.float64,
)


class M27InputError(ValueError):
    def __init__(self, code: str, hint: str) -> None:
        super().__init__(hint)
        self.detail = {"code": code, "hint": hint}


def _alignment_request(payload: Dict[str, Any], default_mode: str) -> Tuple[str, str, str]:
    text = payload.get("text")
    if text is not None and not isinstance(text, str):
        raise M27InputError("unsupported_text", "对齐原文须为普通话或英语文本")
    text = (text or "").strip()
    mode = payload.get("alignment_mode", "guided" if text else default_mode)
    if mode not in ("none", "guided"):
        raise M27InputError("unsupported_mode", "只支持原文引导对齐，请选择提供原文或仅重建声道")
    lang = payload.get("lang") or "auto"
    if lang not in ("auto", "zh", "en"):
        raise M27InputError("unsupported_language", "模型支持普通话与英语")
    return text, lang, mode


def _decode_input_audio(payload: Dict[str, Any]) -> np.ndarray:
    encoded = payload.get("wav_base64") or payload.get("audio_base64")
    if not isinstance(encoded, str) or not encoded:
        raise M27InputError("validation_error", "请提供待处理的音频")
    try:
        content = decode_base64_payload(encoded, field="wav_base64")
    except ValueError as exc:
        raise M27InputError("invalid_audio", str(exc)) from exc
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
        tf.write(content)
        tmp_path = Path(tf.name)
    try:
        wav = ofr.load_audio_16k(tmp_path, max_duration_sec=MAX_INPUT_DURATION_S)
    except ValueError as exc:
        if "超过上限" in str(exc):
            raise M27InputError("audio_too_long", "单次处理最多 60 秒录音，请分段处理") from exc
        if "有效时长不足" in str(exc):
            raise M27InputError("audio_too_short", "录音至少需要 80 毫秒") from exc
        raise M27InputError("invalid_audio", "无法解码音频，请重新导入受支持的录音文件") from exc
    finally:
        tmp_path.unlink(missing_ok=True)
    if len(wav) < 4 * WAVLM_HOP_SAMPLES:
        raise M27InputError("audio_too_short", "录音至少需要 80 毫秒")
    return wav


def _decode_speaker_audio(encoded: str, *, field: str = "speaker_ref_wav_base64") -> np.ndarray:
    try:
        content = decode_base64_payload(encoded, field=field, max_bytes=32 * 1024 * 1024)
    except ValueError as exc:
        raise M27InputError("invalid_audio", str(exc)) from exc
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
        tf.write(content)
        tmp_path = Path(tf.name)
    try:
        return ofr.load_audio_16k(tmp_path, max_duration_sec=30.0)
    except ValueError as exc:
        raise M27InputError("invalid_audio", f"无法解码参考音频: {exc}") from exc
    finally:
        tmp_path.unlink(missing_ok=True)


def _alignment_result(analysis: Dict[str, Any]) -> Dict[str, Any]:
    if analysis.get("alignment_error"):
        return {"alignment_error": analysis["alignment_error"]}
    if analysis.get("mode") != "guided":
        return {}
    meta = analysis["model_meta"]
    return {
        "alignment": {
            **{key: analysis[key] for key in ("textgrid", "phones", "syllables", "mode", "align_score")},
            "model": VOX2ALIGN_LABEL,
            "model_version": meta["version"],
            "model_step": meta.get("step"),
        }
    }


def _m27_to_tract19(m27_50hz: np.ndarray) -> np.ndarray:
    arr = np.asarray(m27_50hz, dtype=np.float64)
    tract17 = np.clip(arr[..., :17], _M27_TRACT17_MIN, _M27_TRACT17_MAX)
    tract19 = np.zeros(arr.shape[:-1] + (19,), dtype=np.float64)
    tract19[..., _TRACT_17_TO_19_IDX] = tract17
    return tract19


def _smooth_m27_for_retry(m27_200hz: np.ndarray) -> np.ndarray:
    if len(m27_200hz) < 3:
        return m27_200hz
    out = m27_200hz.copy()
    cols = list(range(17)) + list(range(19, 27))
    inner = (
        0.25 * m27_200hz[:-2, cols]
        + 0.5 * m27_200hz[1:-1, cols]
        + 0.25 * m27_200hz[2:, cols]
    )
    out[1:-1, cols] = inner
    return out


class M27Bridge:
    """Thread-safe zero-PyTorch ONNX manager for Vox2Tract-Lite, Vox2Align-Lite v2, Vox2Spk-Lite, and Tract2Vox-Lite."""

    def __init__(self, dense_manager: Optional[DenseEngineManager] = None) -> None:
        self._dense = dense_manager or DenseEngineManager()
        self._invert_lock = threading.Lock()
        self._vocoder_lock = threading.Lock()
        self._pool_lock = threading.Lock()
        self._loaded_device: Optional[str] = None
        self._stage5_loaded: Optional[str] = None
        self._preview_vec: Optional[np.ndarray] = None
        self._custom_spk_cache: OrderedDict[Tuple[str, str], np.ndarray] = OrderedDict()

    @classmethod
    def ensure_tt3_imports(cls) -> None:
        ensure_pure_numpy_imports()
        if str(VTL_NATIVE_ROOT) not in sys.path:
            sys.path.insert(0, str(VTL_NATIVE_ROOT))

    def _ensure_tt3_imports(self) -> None:
        self.ensure_tt3_imports()

    def _validate_requested_device(self, requested_device: Any) -> Optional[Dict[str, Any]]:
        if requested_device not in ("cpu", "cuda"):
            return validation_error("device", "请选择本地 CPU 或 CUDA GPU")
        if requested_device == "cuda" and not ort_cuda_available():
            return validation_error(
                "device",
                "当前 ONNX Runtime 环境未启用 CUDA Provider，请选择本地 CPU 后继续。",
                "device_unavailable",
            )
        return None

    def _preferred_vocoder_device(self) -> str:
        return "cuda" if (self._stage5_loaded == "cuda" and ort_cuda_available()) else "cpu"

    def probe_status(self) -> Dict[str, Any]:
        pr_ok = LOCAL_MODEL_MANAGER.is_enabled("Vox2Tract-Lite") and LOCAL_MODEL_MANAGER.active_path("Vox2Tract-Lite").is_file()
        has_aligner_file = LOCAL_MODEL_MANAGER.active_path("Vox2Align-Lite v2").is_file()
        motor_ok = LOCAL_MODEL_MANAGER.is_enabled("Vox2Align-Lite v2") and has_aligner_file
        joint_or_motor_ok = motor_ok or (pr_ok and not has_aligner_file)
        neural_ok = LOCAL_MODEL_MANAGER.is_enabled("Tract2Vox-Lite") and LOCAL_MODEL_MANAGER.active_path("Tract2Vox-Lite").is_file()
        cuda_avail = ort_cuda_available()
        return {
            "tt3_root_exists": TT3_ROOT.is_dir(),
            "stage4_ready": pr_ok and joint_or_motor_ok,
            "alignment_model": (
                VOX2ALIGN_LABEL
                if pr_ok and motor_ok
                else (LOCAL_MODEL_MANAGER.active_path("Vox2Tract-Lite").name if pr_ok and not has_aligner_file else None)
            ),
            "stage5_ready": neural_ok,
            "default_voice_profile": DEFAULT_TIMBRE_PROFILE.name,
            "default_voice_ready": DEFAULT_TIMBRE_PROFILE.is_file(),
            "cuda_available": cuda_avail,
            "runtime": "onnxruntime",
            "loaded_device": self._loaded_device,
            "stage5_loaded_device": self._stage5_loaded,
            "checkpoints": {
                "pr_encoder": pr_ok,
                "motor_natural": motor_ok,
                "neural_synth": neural_ok,
            },
        }

    def _load_tract2vox(self, requested_device: str = "cpu") -> Tuple[Dict[str, Any], str]:
        _, actual = LOCAL_MODEL_MANAGER.require_session("Tract2Vox-Lite", device=requested_device)
        self._stage5_loaded = actual

        def _gen_callable(m27_norm_batch: np.ndarray, spk_emb: np.ndarray) -> np.ndarray:
            arr = np.asarray(m27_norm_batch, dtype=np.float32)
            spk = np.asarray(spk_emb, dtype=np.float32)
            wav, _ = synthesize_tract2vox(arr, spk, device=actual)
            return wav[None, :]

        def _chunk_gen_callable(
            m27_norm_batch: np.ndarray,
            spk_emb: np.ndarray,
            *,
            m27_phys_dpa: Optional[np.ndarray] = None,
            articulation_spans: Optional[List[Dict[str, Any]]] = None,
            step_hz: int = 200,
        ) -> Tuple[np.ndarray, Dict[str, Any]]:
            from chunked_synthesis import synthesize_tract2vox_chunked

            wav, _, stats = synthesize_tract2vox_chunked(
                np.asarray(m27_norm_batch, dtype=np.float32),
                np.asarray(spk_emb, dtype=np.float32),
                m27_phys_dpa=m27_phys_dpa,
                articulation_spans=articulation_spans,
                step_hz=step_hz,
                device=actual,
            )
            return wav, stats

        return {"device": actual, "gen": _gen_callable, "chunk_gen": _chunk_gen_callable}, actual

    @staticmethod
    def _interp_50_to_200(arr_50: np.ndarray) -> np.ndarray:
        n50 = arr_50.shape[0]
        n200 = n50 * 4
        if n50 <= 1:
            return np.repeat(arr_50, n200, axis=0)
        t50 = (np.arange(n50, dtype=np.float64) + 0.5) / float(CONTROL_HZ_50)
        t200 = (np.arange(n200, dtype=np.float64) + 0.5) / float(CONTROL_HZ_200)
        out = np.empty((n200, arr_50.shape[1]), dtype=np.float64)
        for d in range(arr_50.shape[1]):
            out[:, d] = np.interp(t200, t50, arr_50[:, d])
        return out

    def _extract_anim(self, m27_50hz_dpa: np.ndarray, fps: int = 25) -> Dict[str, Any]:
        self.ensure_tt3_imports()
        from tt3.tract_anim import extract_m27_animation

        with self._dense.lease("JD2") as engine:
            animation = extract_m27_animation(engine, m27_50hz_dpa, fps=fps)
        for frame in animation["frames"]:
            frame["pr_pa"] = frame.pop("pr") / 10.0
        return animation

    @staticmethod
    def _run_vtl_attempt(
        eng: Any,
        m27_200: np.ndarray,
        *,
        tube_hz: int,
        dense_manager: Optional[DenseEngineManager] = None,
    ) -> Optional[np.ndarray]:
        from kf_ipa_synth.m27_contract import m27_to_vtl19_glottis9_shimmer
        from dense_channel import DEFAULT_SECTIONS, _make_pose_cache_key

        stride = max(1, CONTROL_HZ_200 // tube_hz)
        tract19, glottis9, shimmer = m27_to_vtl19_glottis9_shimmer(m27_200)
        tract19 = np.clip(tract19, eng.minimum, eng.maximum)
        glottis9 = np.clip(glottis9, eng.gmin, eng.gmax)

        n_steps = tract19.shape[0]
        step_samples = 240  # 5 ms @ 48 kHz
        anchors = list(range(0, n_steps, stride))
        if anchors[-1] != n_steps - 1:
            anchors.append(n_steps - 1)

        try:
            tubes: Dict[int, Dict[str, Any]] = {}
            if dense_manager is not None and len(anchors) >= 12:
                anchor_keys: Dict[int, Tuple[Any, ...]] = {}
                pose_specs = []
                for idx in anchors:
                    cur_p = tract19[idx]
                    key = _make_pose_cache_key("JD2", DEFAULT_SECTIONS, False, cur_p, 1.0, 0.0, None, None)
                    anchor_keys[idx] = key
                    pose_specs.append((key, cur_p, 1.0, 0.0, None, None, False))
                tubes_by_key, _, _, _ = dense_manager.prepare_tubes_batch("JD2", pose_specs, section_count=DEFAULT_SECTIONS)
                for idx in anchors:
                    tubes[idx] = tubes_by_key[anchor_keys[idx]]
            else:
                prev_p: Optional[np.ndarray] = None
                prev_t: Optional[Dict[str, Any]] = None
                for idx in anchors:
                    cur_p = tract19[idx]
                    if prev_p is not None and float(np.max(np.abs(cur_p - prev_p))) < 1e-4:
                        tubes[idx] = prev_t
                    else:
                        prev_t = eng.prepare_tube(cur_p)
                        prev_p = cur_p
                        tubes[idx] = prev_t

            last_shim = float(shimmer[0])
            eng.configure_perturbation({"jitter": 0.0, "shimmer": last_shim, "seed": 700}, restart=True)
            first_tube = tubes[0]
            initial = glottis9[0].copy()
            initial[1] = 0.0
            eng.reset_tube(first_tube, np.ascontiguousarray(initial))
            chunks = [eng.block_tube(first_tube, np.ascontiguousarray(glottis9[0]), step_samples)]
            ai = 0
            n_anchors = len(anchors)
            for k in range(1, n_steps):
                cur_shim = float(shimmer[k])
                if abs(cur_shim - last_shim) > 1.0:
                    eng.configure_perturbation({"jitter": 0.0, "shimmer": cur_shim, "seed": 700}, restart=False)
                    last_shim = cur_shim
                if stride == 1:
                    tube = tubes[k]
                else:
                    while ai + 1 < n_anchors and k > anchors[ai + 1]:
                        ai += 1
                    a0 = anchors[ai]
                    a1 = anchors[ai + 1] if ai + 1 < n_anchors else a0
                    if a0 == a1 or k == a0:
                        tube = tubes[a0]
                    elif k == a1:
                        tube = tubes[a1]
                    else:
                        t0_d, t1_d = tubes[a0], tubes[a1]
                        if t0_d is t1_d:
                            tube = t0_d
                        else:
                            alpha = (k - a0) / (a1 - a0)
                            tube = {
                                "lengths": t0_d["lengths"] * (1.0 - alpha) + t1_d["lengths"] * alpha,
                                "areas": t0_d["areas"] * (1.0 - alpha) + t1_d["areas"] * alpha,
                                "articulators": t0_d["articulators"] if alpha < 0.5 else t1_d["articulators"],
                                "extras": t0_d["extras"] * (1.0 - alpha) + t1_d["extras"] * alpha,
                            }
                chunks.append(eng.block_tube(tube, np.ascontiguousarray(glottis9[k]), step_samples))
        except (RuntimeError, ValueError):
            return None

        wav_48k = np.concatenate(chunks)
        if not np.isfinite(wav_48k).all() or float(np.max(np.abs(wav_48k))) > 10.0:
            return None
        return wav_48k

    def _synthesize_vtl_from_m27(self, m27_50hz_dpa: np.ndarray, *, tube_hz: int = 100, audio_gain: str | None = None) -> bytes:
        self.ensure_tt3_imports()
        if tube_hz not in (50, 100, 200):
            raise ValueError(f"tube_hz 必须为 50、100 或 200，收到 {tube_hz}")

        m27_200 = self._interp_50_to_200(m27_50hz_dpa)
        smoothed = _smooth_m27_for_retry(m27_200)
        attempts = [
            (m27_200, tube_hz),
            (smoothed, tube_hz),
            (_smooth_m27_for_retry(smoothed), 200),
        ]
        step_samples = 240  # 5 ms @ 48 kHz
        with self._dense.lease("JD2") as eng:
            for candidate, cur_hz in attempts:
                wav_48k = self._run_vtl_attempt(eng, candidate, tube_hz=cur_hz, dense_manager=self._dense)
                if wav_48k is not None:
                    wav_f64 = apply_synthesis_gain(
                        finish_synthesis(wav_48k, m27_200[:, 18] / 10.0, step_samples, len(m27_200) * step_samples),
                        audio_gain,
                    )
                    return pcm_float_to_wav_bytes(wav_f64, SAMPLE_RATE_48K)
        raise RuntimeError("VTL 物理声管合成出现数值发散，请平滑过渡轨迹后重试")

    def _preview_timbre(self, models: Optional[Dict[str, Any]] = None) -> np.ndarray:
        del models
        with self._pool_lock:
            vec = self._preview_vec
        if vec is None:
            vec = load_speaker_profile_embedding(DEFAULT_TIMBRE_PROFILE)
            with self._pool_lock:
                self._preview_vec = vec
        return vec[None, :]

    def _resolve_custom_timbre(self, models: Dict[str, Any], spk_b64: str, *, field: str = "speaker_wav_base64") -> np.ndarray:
        dev_key = str(models.get("device", "cpu"))
        active_spk = str(LOCAL_MODEL_MANAGER.active_path("Vox2Spk-Lite"))
        digest = hashlib.sha256(f"{active_spk}:{spk_b64.strip()}".encode("utf-8")).hexdigest()
        cache_key = (digest, dev_key)
        with self._pool_lock:
            cached = self._custom_spk_cache.get(cache_key)
            if cached is not None:
                self._custom_spk_cache.move_to_end(cache_key)
                return cached

        wav_16k = _decode_speaker_audio(spk_b64, field=field)
        if len(wav_16k) < 4 * WAVLM_HOP_SAMPLES:
            raise M27InputError("audio_too_short", "参考音色录音至少需要 80 毫秒")
        length = 10 * SAMPLE_RATE_16K
        start = max(0, (len(wav_16k) - length) // 2)
        clip = np.ascontiguousarray(wav_16k[start : start + length], dtype=np.float32)
        emb, _ = extract_speaker_embedding(clip, device=dev_key)
        e_spk = emb[None, :]
        with self._pool_lock:
            self._custom_spk_cache[cache_key] = e_spk
            self._custom_spk_cache.move_to_end(cache_key)
            while len(self._custom_spk_cache) > 16:
                self._custom_spk_cache.popitem(last=False)
        return e_spk

    def _synthesize_neural(
        self,
        m27_50hz_dpa: np.ndarray,
        speaker_wav_16k: Optional[np.ndarray],
        device: str,
        *,
        audio_gain: str | None = None,
    ) -> Tuple[bytes, str]:
        self.ensure_tt3_imports()
        from kf_ipa_synth.m27_contract import normalize_m27

        m27_norm = normalize_m27(m27_50hz_dpa.astype(np.float32))
        with self._vocoder_lock:
            s5, actual = self._load_tract2vox(device)
            if speaker_wav_16k is None:
                e_spk = self._preview_timbre(s5)
            else:
                length = 10 * SAMPLE_RATE_16K
                start = max(0, (len(speaker_wav_16k) - length) // 2)
                clip = np.ascontiguousarray(speaker_wav_16k[start : start + length], dtype=np.float32)
                emb, _ = extract_speaker_embedding(clip, device=actual)
                e_spk = emb[None, :]
            wav_16k = np.asarray(s5["gen"](m27_norm[None, :, :], e_spk)).reshape(-1).astype(np.float64)
        expected = len(m27_50hz_dpa) * WAVLM_HOP_SAMPLES
        audio = finish_synthesis(wav_16k, m27_50hz_dpa[:, 18] / 10.0, WAVLM_HOP_SAMPLES, expected, SAMPLE_RATE_16K)
        return pcm_float_to_wav_bytes(apply_synthesis_gain(audio, audio_gain), SAMPLE_RATE_16K), actual

    def synthesize_dense_neural(self, payload: Dict[str, Any], predicted_rows: Optional[np.ndarray] = None) -> Dict[str, Any]:
        """Decode the shared VTL control timeline with the local Tract2Vox-Lite ONNX neural vocoder."""
        speaker = payload.get("speaker", "JD2")
        if speaker not in ("JD2", "JD2-2D"):
            return validation_error(
                "speaker",
                "Tract2Vox-Lite 使用 JD2 构型与默认讲解音色。W02 或 M01 请选物理合成。",
                "unsupported_geometry",
            )
        step_hz = payload.get("step_hz", 200)
        if type(step_hz) is not int or step_hz not in (50, 100, 200):
            return validation_error("step_hz", "Tract2Vox-Lite 接收 50、100 或 200 Hz 的控制轨")

        f0_raw = payload.get("f0_hz")
        if not isinstance(f0_raw, list):
            return validation_error("f0_hz", "控制轨须包含 f0_hz 数值数组")
        count = len(f0_raw)
        max_frames = 60 * step_hz
        if not 1 <= count <= max_frames:
            return out_of_range_error("f0_hz.length", count, 1, max_frames, "frames", "单次 Tract2Vox-Lite 合成最多 60 秒")

        f0, err = validate_positive_series("f0_hz", f0_raw, count, "Hz")
        if err:
            return err
        pressure, err = validate_scalar_series("pressure_pa", payload.get("pressure_pa"), count, 0.0, 1600.0, "Pa")
        if err:
            return err
        tract, err = validate_tract19_frames(payload.get("tract_frames"), field="tract_frames", expected_len=count)
        if err:
            return err
        glottis, err = validate_glottis_frames(payload.get("glottis_frames"), count, field="glottis_frames")
        if err:
            return err
        assert f0 is not None and pressure is not None and tract is not None and glottis is not None

        if glottis.shape[1] == 7:
            shimmer_raw = payload.get("shimmer", 0.0)
            err = validate_scalar_range("shimmer", shimmer_raw, 0.0, 100.0, "%")
            if err:
                return err
            glottis = np.column_stack((glottis, np.full(count, float(shimmer_raw))))

        if payload.get("lip_width_frames") is not None:
            _, err = validate_scalar_series("lip_width_frames", payload["lip_width_frames"], count, 0.55, 1.6, "ratio")
            if err:
                return err
        if payload.get("larynx_height_frames") is not None:
            _, err = validate_scalar_series("larynx_height_frames", payload["larynx_height_frames"], count, -1.0, 1.0, "cm")
            if err:
                return err
        if payload.get("tongue_shape_frames") is not None:
            err = validate_shape_frames(payload["tongue_shape_frames"], count, field="tongue_shape_frames")
            if err:
                return err
        if payload.get("lip_shape_frames") is not None:
            err = validate_shape_frames(payload["lip_shape_frames"], count, field="lip_shape_frames")
            if err:
                return err

        extras = stage5_geometry_extras(payload)
        if extras and predicted_rows is None:
            first = extras[0]
            where = f"第 {first['frame']} 帧的 " if first["frame"] is not None else ""
            return validation_error(
                first["field"],
                f"Tract2Vox-Lite 的 M27 控制不含唇宽、喉位、舌面/唇形局部偏移与手动舌根通道；"
                f"{where}{first['field']} 为非默认值。请开启 IPA2Tract 协同构音或改用 VTL 物理合成。",
                "unsupported_geometry",
            )

        step_samples = SAMPLE_RATE_48K // step_hz
        sample_count = payload.get("sample_count", count * step_samples)
        if type(sample_count) is not int or not (count - 1) * step_samples < sample_count <= count * step_samples:
            return out_of_range_error("sample_count", sample_count, (count - 1) * step_samples + 1, count * step_samples, "samples")

        device = payload.get("device", "cpu")
        dev_err = self._validate_requested_device(device)
        if dev_err:
            return dev_err

        raw_spk_b64 = payload.get("speaker_wav_base64")
        if raw_spk_b64 is None:
            raw_spk_b64 = payload.get("speaker_ref_wav_base64")
        if raw_spk_b64 is not None and not isinstance(raw_spk_b64, str):
            return validation_error("speaker_wav_base64", "speaker_wav_base64 须为 Base64 WAV 字符串")
        custom_spk_b64 = raw_spk_b64.strip() if isinstance(raw_spk_b64, str) else ""

        raw_spans = payload.get("segment_edits") or (payload.get("articulation_spans") if predicted_rows is None else None)
        if isinstance(raw_spans, list):
            from keyframe_lite import apply_keyframe_bell_overlays_tract19

            tract_mod, bell_err = apply_keyframe_bell_overlays_tract19(
                tract, raw_spans, field_prefix="segment_edits" if "segment_edits" in payload else "articulation_spans",
            )
            if bell_err:
                return bell_err
            assert tract_mod is not None
            tract = tract_mod

        rows = np.column_stack((tract[:, _TRACT_17_TO_19_IDX], f0, pressure * 10.0, glottis))
        factor = step_hz // CONTROL_HZ_50
        target_count = (count + factor - 1) // factor
        missing = target_count * factor - count
        if missing:
            rows = np.pad(rows, ((0, missing), (0, 0)), mode="edge")
        grouped = rows.reshape(target_count, factor, 27)
        rows_50 = grouped.mean(axis=1)
        rows_50[:, 18] = np.median(grouped[:, :, 18], axis=1)
        if predicted_rows is not None:
            rows_50 = predicted_rows
        else:
            spans = payload.get("articulation_spans")
            if isinstance(spans, list):
                centers = np.minimum(count - 1, np.arange(target_count) * factor + factor // 2)
                protected = np.zeros(target_count, dtype=bool)
                for span in spans:
                    if isinstance(span, dict) and span.get("phase") == "silence":
                        lo, hi = span.get("start_frame"), span.get("end_frame")
                        if type(lo) is int and type(hi) is int:
                            protected |= (centers >= lo) & (centers < hi)
                preserve_stop_transients(rows_50, rows[:count], spans, factor, protected)
            neural_trill_spans: List[Tuple[float, float, str]] = []
            for item in (payload.get("trill_spans") or []):
                if isinstance(item, (list, tuple)) and len(item) == 3:
                    pl = resolve_trill_place(str(item[2]))
                    if pl and float(item[1]) > float(item[0]):
                        neural_trill_spans.append((float(item[0]), float(item[1]), pl))
                elif isinstance(item, dict):
                    pl = resolve_trill_place(item.get("place") or item.get("trill") or item.get("ipa"))
                    if pl and float(item.get("end_s", 0)) > float(item.get("start_s", 0)):
                        neural_trill_spans.append((float(item["start_s"]), float(item["end_s"]), pl))
            if not neural_trill_spans and isinstance(payload.get("articulation_spans"), list):
                for sp in payload["articulation_spans"]:
                    if isinstance(sp, dict) and sp.get("phase", "normal") not in ("silence", "closure", "aspiration"):
                        pl = resolve_trill_place(sp.get("trill") or sp.get("ipa"))
                        a_f, b_f = sp.get("start_frame"), sp.get("end_frame")
                        if pl and type(a_f) is int and type(b_f) is int and 0 <= a_f < b_f <= count:
                            neural_trill_spans.append((a_f / float(step_hz), b_f / float(step_hz), pl))
            if neural_trill_spans:
                rows_50 = apply_trill_to_m27(rows_50, neural_trill_spans, 50.0, modulate_aerodynamics_50hz=True)
            elif factor > 1:
                for ctl_col in (5, 6, 11):
                    ptp = np.ptp(grouped[:, :, ctl_col], axis=1)
                    osc = np.flatnonzero(ptp >= 0.25)
                    if osc.size >= 3:
                        for k_idx, g_idx in enumerate(osc):
                            rows_50[g_idx, ctl_col] = (
                                np.max(grouped[g_idx, :, ctl_col]) if k_idx % 2 == 0 else np.min(grouped[g_idx, :, ctl_col])
                            )

        lead = np.repeat(rows_50[:1], 4, axis=0)
        tail = np.repeat(rows_50[-1:], 4, axis=0)
        lead[:, 18] = tail[:, 18] = 0.0
        controls = np.concatenate((lead, rows_50, tail)).astype(np.float32)

        self.ensure_tt3_imports()
        from kf_ipa_synth.m27_contract import normalize_m27
        from scipy.signal import resample_poly

        before = time.perf_counter()
        chunk_stats: Optional[Dict[str, Any]] = None
        shifted_spans: Optional[List[Dict[str, Any]]] = None
        raw_art_spans = payload.get("articulation_spans")
        if isinstance(raw_art_spans, list) and raw_art_spans:
            lead_in_step = len(lead) * factor
            shifted_spans = []
            for sp in raw_art_spans:
                if isinstance(sp, dict) and type(sp.get("start_frame")) is int and type(sp.get("end_frame")) is int:
                    shifted_spans.append({
                        **sp,
                        "start_frame": sp["start_frame"] + lead_in_step,
                        "end_frame": sp["end_frame"] + lead_in_step,
                    })
        try:
            with self._vocoder_lock:
                models, actual = self._load_tract2vox(str(device))
                e_spk = (
                    self._resolve_custom_timbre(models, custom_spk_b64, field="speaker_wav_base64")
                    if custom_spk_b64
                    else self._preview_timbre(models)
                )
                inputs = normalize_m27(controls)[None, :, :]
                chunk_gen = models.get("chunk_gen")
                if callable(chunk_gen):
                    generated, chunk_stats = chunk_gen(
                        inputs,
                        e_spk,
                        m27_phys_dpa=controls,
                        articulation_spans=shifted_spans,
                        step_hz=step_hz,
                    )
                else:
                    generated = np.asarray(models["gen"](inputs, e_spk)).reshape(-1)
        except M27InputError as exc:
            return {"ok": False, "error": exc.detail}
        except ModelUnloadedError as exc:
            return {"ok": False, "error": {"code": exc.code, "model": exc.model_name, "hint": exc.hint}}
        audio = resample_poly(generated, 3, 1)
        cropped = audio[len(lead) * SAMPLES_PER_FRAME_48K:]
        audio = finish_synthesis(cropped, pressure, step_samples, sample_count)
        wav = pcm_float_to_wav_bytes(apply_synthesis_gain(audio, payload.get("audio_gain")), SAMPLE_RATE_48K)
        result: Dict[str, Any] = {
            "ok": True,
            "wav_base64": base64.b64encode(wav).decode("ascii"),
            "duration_s": sample_count / SAMPLE_RATE_48K,
            "sample_rate_hz": SAMPLE_RATE_48K,
            "num_frames": count,
            "speaker": speaker,
            "device_effective": "cuda" if "cuda" in actual else "cpu",
            "model_ms": round((time.perf_counter() - before) * 1000),
            "source_badge": "Tract2Vox-Lite · 自定义音色" if custom_spk_b64 else "Tract2Vox-Lite 神经声码器",
            "synth_mode": "neural",
            "voice_profile": "custom-reference" if custom_spk_b64 else DEFAULT_TIMBRE_PROFILE.name.removesuffix(".spk.json"),
        }
        if chunk_stats is not None:
            result["chunk_stats"] = chunk_stats
        if extras:
            result["ignored_geometry_fields"] = sorted({item["field"] for item in extras})
        if payload.get("return_control_track"):
            control_rows = rows_50.copy()
            control_rows[:, 18] /= 10.0
            result["m27_control_50hz_pa"] = control_rows.tolist()
        return result

    def synthesize_dense_neural_stream(self, payload: Dict[str, Any], predicted_rows: Optional[np.ndarray] = None):
        """Yield streaming metadata + 48 kHz PCM chunks for immediate first-chunk playback & parallel follow-up."""
        speaker = payload.get("speaker", "JD2")
        if speaker not in ("JD2", "JD2-2D"):
            yield {"ok": False, "error": validation_error(
                "speaker",
                "Tract2Vox-Lite 使用 JD2 构型与默认讲解音色。W02 或 M01 请选物理合成。",
                "unsupported_geometry",
            )["error"]}
            return
        step_hz = payload.get("step_hz", 200)
        if type(step_hz) is not int or step_hz not in (50, 100, 200):
            yield validation_error("step_hz", "Tract2Vox-Lite 接收 50、100 或 200 Hz 的控制轨")
            return
        f0_raw = payload.get("f0_hz")
        if not isinstance(f0_raw, list):
            yield validation_error("f0_hz", "控制轨须包含 f0_hz 数值数组")
            return
        count = len(f0_raw)
        max_frames = 60 * step_hz
        if not 1 <= count <= max_frames:
            yield out_of_range_error("f0_hz.length", count, 1, max_frames, "frames", "单次 Tract2Vox-Lite 合成最多 60 秒")
            return
        f0, err = validate_positive_series("f0_hz", f0_raw, count, "Hz")
        if err:
            yield err
            return
        pressure, err = validate_scalar_series("pressure_pa", payload.get("pressure_pa"), count, 0.0, 1600.0, "Pa")
        if err:
            yield err
            return
        tract, err = validate_tract19_frames(payload.get("tract_frames"), field="tract_frames", expected_len=count)
        if err:
            yield err
            return
        glottis, err = validate_glottis_frames(payload.get("glottis_frames"), count, field="glottis_frames")
        if err:
            yield err
            return
        assert f0 is not None and pressure is not None and tract is not None and glottis is not None
        if glottis.shape[1] == 7:
            shimmer_raw = payload.get("shimmer", 0.0)
            err = validate_scalar_range("shimmer", shimmer_raw, 0.0, 100.0, "%")
            if err:
                yield err
                return
            glottis = np.column_stack((glottis, np.full(count, float(shimmer_raw))))
        extras = stage5_geometry_extras(payload)
        if extras and predicted_rows is None:
            first = extras[0]
            where = f"第 {first['frame']} 帧的 " if first["frame"] is not None else ""
            yield validation_error(
                first["field"],
                f"Tract2Vox-Lite 的 M27 控制不含唇宽、喉位、舌面/唇形局部偏移与手动舌根通道；"
                f"{where}{first['field']} 为非默认值。请开启 IPA2Tract 协同构音或改用 VTL 物理合成。",
                "unsupported_geometry",
            )
            return
        step_samples = SAMPLE_RATE_48K // step_hz
        sample_count = payload.get("sample_count", count * step_samples)
        if type(sample_count) is not int or not (count - 1) * step_samples < sample_count <= count * step_samples:
            yield out_of_range_error("sample_count", sample_count, (count - 1) * step_samples + 1, count * step_samples, "samples")
            return
        device = payload.get("device", "cpu")
        dev_err = self._validate_requested_device(device)
        if dev_err:
            yield dev_err
            return
        raw_spk_b64 = payload.get("speaker_wav_base64")
        if raw_spk_b64 is None:
            raw_spk_b64 = payload.get("speaker_ref_wav_base64")
        if raw_spk_b64 is not None and not isinstance(raw_spk_b64, str):
            yield validation_error("speaker_wav_base64", "speaker_wav_base64 须为 Base64 WAV 字符串")
            return
        custom_spk_b64 = raw_spk_b64.strip() if isinstance(raw_spk_b64, str) else ""

        raw_spans = payload.get("segment_edits") or (payload.get("articulation_spans") if predicted_rows is None else None)
        if isinstance(raw_spans, list):
            from keyframe_lite import apply_keyframe_bell_overlays_tract19

            tract_mod, bell_err = apply_keyframe_bell_overlays_tract19(
                tract, raw_spans, field_prefix="segment_edits" if "segment_edits" in payload else "articulation_spans",
            )
            if bell_err:
                yield bell_err
                return
            assert tract_mod is not None
            tract = tract_mod

        rows = np.column_stack((tract[:, _TRACT_17_TO_19_IDX], f0, pressure * 10.0, glottis))
        factor = step_hz // CONTROL_HZ_50
        target_count = (count + factor - 1) // factor
        missing = target_count * factor - count
        if missing:
            rows = np.pad(rows, ((0, missing), (0, 0)), mode="edge")
        grouped = rows.reshape(target_count, factor, 27)
        rows_50 = grouped.mean(axis=1)
        rows_50[:, 18] = np.median(grouped[:, :, 18], axis=1)
        if predicted_rows is not None:
            rows_50 = predicted_rows
        else:
            spans = payload.get("articulation_spans")
            if isinstance(spans, list):
                centers = np.minimum(count - 1, np.arange(target_count) * factor + factor // 2)
                protected = np.zeros(target_count, dtype=bool)
                for span in spans:
                    if isinstance(span, dict) and span.get("phase") == "silence":
                        lo, hi = span.get("start_frame"), span.get("end_frame")
                        if type(lo) is int and type(hi) is int:
                            protected |= (centers >= lo) & (centers < hi)
                preserve_stop_transients(rows_50, rows[:count], spans, factor, protected)

        lead_n = 4
        tail_n = 4
        lead = np.repeat(rows_50[:1], lead_n, axis=0)
        tail = np.repeat(rows_50[-1:], tail_n, axis=0)
        lead[:, 18] = tail[:, 18] = 0.0
        controls = np.concatenate((lead, rows_50, tail)).astype(np.float32)

        self.ensure_tt3_imports()
        from kf_ipa_synth.m27_contract import normalize_m27
        from chunked_synthesis import iter_tract2vox_chunks_48k_stream
        from dense_channel import _soft_limit_audio

        before = time.perf_counter()
        try:
            with self._vocoder_lock:
                models, actual = self._load_tract2vox(str(device))
                e_spk = (
                    self._resolve_custom_timbre(models, custom_spk_b64, field="speaker_wav_base64")
                    if custom_spk_b64
                    else self._preview_timbre(models)
                )
        except M27InputError as exc:
            yield {"ok": False, "error": exc.detail}
            return
        except ModelUnloadedError as exc:
            yield {"ok": False, "error": {"code": exc.code, "model": exc.model_name, "hint": exc.hint}}
            return

        inputs = normalize_m27(controls)[None, :, :]
        art_spans = payload.get("articulation_spans") if isinstance(payload.get("articulation_spans"), list) else None
        stream_iter = iter_tract2vox_chunks_48k_stream(
            inputs,
            e_spk,
            m27_phys_dpa=rows_50,
            lead_frames=lead_n,
            tail_frames=tail_n,
            sample_count_48k=sample_count,
            articulation_spans=art_spans,
            step_hz=step_hz,
            device=actual,
        )

        # Build per-sample silence gate envelope from pressure_pa so silent pauses stay dead-quiet
        pr_samples = np.repeat(pressure.astype(np.float32), step_samples)[:sample_count]
        if len(pr_samples) < sample_count:
            pr_samples = np.pad(pr_samples, (0, sample_count - len(pr_samples)), mode="edge")
        gate = np.clip((pr_samples - 2.0) / 18.0, 0.0, 1.0)
        # Smooth 4 ms moving average on gate to avoid clicks
        if len(gate) >= 192:
            k_win = np.ones(192, dtype=np.float32) / 192.0
            gate = np.convolve(gate, k_win, mode="same").astype(np.float32)

        cache_hits = 0
        total_chunks = 0
        parallel_workers = 1
        meta_base: Dict[str, Any] = {
            "ok": True,
            "type": "meta",
            "sample_rate_hz": SAMPLE_RATE_48K,
            "total_samples": sample_count,
            "duration_s": sample_count / SAMPLE_RATE_48K,
            "num_frames": count,
            "speaker": speaker,
            "device_effective": "cuda" if "cuda" in actual else "cpu",
            "source_badge": "Tract2Vox-Lite · 自定义音色" if custom_spk_b64 else "Tract2Vox-Lite 神经声码器",
            "synth_mode": "neural",
            "voice_profile": "custom-reference" if custom_spk_b64 else DEFAULT_TIMBRE_PROFILE.name.removesuffix(".spk.json"),
        }
        if extras:
            meta_base["ignored_geometry_fields"] = sorted({item["field"] for item in extras})
        if payload.get("return_control_track"):
            control_rows = rows_50.copy()
            control_rows[:, 18] /= 10.0
            meta_base["m27_control_50hz_pa"] = control_rows.tolist()

        for evt in stream_iter:
            if evt["type"] == "plan":
                total_chunks = int(evt["total_chunks"])
                parallel_workers = int(evt["parallel_workers"])
                yield {
                    **meta_base,
                    "total_chunks": total_chunks,
                    "parallel_workers": parallel_workers,
                    "cut_reasons": evt.get("cut_reasons", []),
                }
                continue
            if evt["type"] == "chunk":
                seg = np.asarray(evt["audio_48k"], dtype=np.float64)
                s_start = int(evt["start_sample"])
                s_end = min(sample_count, s_start + len(seg))
                n_valid = max(0, s_end - s_start)
                if n_valid == 0:
                    continue
                seg = seg[:n_valid] * gate[s_start:s_end]
                seg = _soft_limit_audio(seg, knee=0.85, ceiling=0.96)
                pcm16 = np.clip(np.round(seg * 32767.0), -32768, 32767).astype("<i2")
                if evt.get("cache_hit"):
                    cache_hits += 1
                yield {
                    "ok": True,
                    "type": "chunk",
                    "index": int(evt["index"]),
                    "total_chunks": total_chunks,
                    "start_sample": s_start,
                    "core_start_sample": int(evt["core_start_sample"]),
                    "sample_count": n_valid,
                    "overlap_left_samples": int(evt["overlap_left_samples"]),
                    "left_is_silence": bool(evt["left_is_silence"]),
                    "right_is_silence": bool(evt["right_is_silence"]),
                    "cut_reason": str(evt["cut_reason"]),
                    "cache_hit": bool(evt["cache_hit"]),
                    "model_ms": float(evt["model_ms"]),
                    "pcm_i16_b64": base64.b64encode(pcm16.tobytes()).decode("ascii"),
                }

        yield {
            "ok": True,
            "type": "done",
            "total_chunks": total_chunks,
            "cache_hits": cache_hits,
            "parallel_workers": parallel_workers,
            "model_ms": round((time.perf_counter() - before) * 1000),
        }

    def hold_preview(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Render a constant 50 Hz hold using Tract2Vox-Lite ONNX."""
        row = payload.get("controls")
        count = payload.get("frames")
        if type(count) is not int or not 25 <= count <= 150:
            return out_of_range_error("frames", count, 25, 150, "frames", "预览帧数须为 25–150 帧")
        arr, err = validate_m27_pa([row] if isinstance(row, list) else None, field="controls", min_frames=1, max_frames=1)
        if err:
            return err
        assert arr is not None

        self.ensure_tt3_imports()
        from kf_ipa_synth.m27_contract import normalize_m27

        start = time.perf_counter()
        controls = np.repeat(arr.astype(np.float32), count, axis=0)
        controls[:, 18] *= 10.0
        target_dev = self._preferred_vocoder_device()
        try:
            with self._vocoder_lock:
                models, actual = self._load_tract2vox(target_dev)
                normalized = normalize_m27(controls)[None, :, :]
                generated = np.asarray(models["gen"](normalized, self._preview_timbre(models))).reshape(-1).astype(np.float64)
        except ModelUnloadedError as exc:
            return {"ok": False, "error": {"code": exc.code, "model": exc.model_name, "hint": exc.hint}}
        audio = finish_synthesis(
            generated,
            np.full(count, float(arr[0, 18]), dtype=np.float64),
            WAVLM_HOP_SAMPLES,
            count * WAVLM_HOP_SAMPLES,
            SAMPLE_RATE_16K,
        )
        pcm = pcm_float_to_wav_bytes(apply_synthesis_gain(audio, payload.get("audio_gain")), SAMPLE_RATE_16K)
        return {
            "ok": True,
            "wav_base64": base64.b64encode(pcm).decode("ascii"),
            "model_ms": round((time.perf_counter() - start) * 1000),
            "device": "cuda" if "cuda" in actual else "cpu",
            "duration_s": count / CONTROL_HZ_50,
        }

    def extract_anim_from_pa(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        arr_pa, err = validate_m27_pa(payload.get("m27_50hz_pa"), field="m27_50hz_pa", min_frames=1, max_frames=3000)
        if err:
            return err
        assert arr_pa is not None
        fps = payload.get("fps", 25)
        if type(fps) is not int or not 5 <= fps <= 50:
            return out_of_range_error("fps", fps, 5, 50, "fps")

        arr_dpa = arr_pa.copy()
        arr_dpa[:, 18] = arr_pa[:, 18] * 10.0
        anim = self._extract_anim(arr_dpa, fps=fps)
        return {"ok": True, "anim": anim}

    def align(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        req_dev = payload.get("device", "cpu")
        dev_err = self._validate_requested_device(req_dev)
        if dev_err:
            return dev_err
        try:
            text, lang, mode = _alignment_request(payload, "guided")
            if mode != "guided" or not text:
                raise M27InputError("text_required", "请提供与录音一致的普通话或英语原文")
            self.ensure_tt3_imports()
            wav = _decode_input_audio(payload)
            with self._invert_lock:
                analysis, device = analyze_waveform_onnx(wav, text=text, lang=lang, alignment_mode="guided", device=str(req_dev))
                self._loaded_device = device
        except M27InputError as exc:
            return {"ok": False, "error": exc.detail}
        except ModelUnloadedError as exc:
            return {"ok": False, "error": {"code": exc.code, "model": exc.model_name, "hint": exc.hint}}
        except (FileNotFoundError, ImportError):
            return {"ok": False, "error": {"code": "model_unavailable", "hint": "本地 Vox2Align-Lite v2 模型或依赖不可用"}}
        result = _alignment_result(analysis)
        if "alignment" not in result:
            return {"ok": False, "error": result.get("alignment_error") or {
                "code": "alignment_failed", "hint": "模型未生成原文对应的音素边界"}}
        return {"ok": True, **result, "device_effective": "cuda" if "cuda" in device else "cpu"}

    def reconstruct(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        req_dev = payload.get("device", "cpu")
        dev_err = self._validate_requested_device(req_dev)
        if dev_err:
            return dev_err
        synth_mode = payload.get("synth_mode", "both")
        if synth_mode not in ("vtl", "neural", "both", "auto", "animation", "glottis"):
            return validation_error("synth_mode", "不支持的声道重建输出模式")
        fps = payload.get("fps", 25)
        if type(fps) is not int or not 5 <= fps <= 50:
            return out_of_range_error("fps", fps, 5, 50, "fps")
        tube_hz = payload.get("tube_hz", 100)
        if type(tube_hz) is not int or tube_hz not in (50, 100, 200):
            return validation_error("tube_hz", "tube_hz 须为 50、100 或 200")

        spk_b64 = payload.get("speaker_ref_wav_base64") or payload.get("speaker_ref_base64")
        voice_profile = payload.get("speaker_profile")
        if voice_profile is not None and (voice_profile != DEFAULT_VOICE_ID or spk_b64):
            return validation_error("speaker_profile", "请选择本机讲解声纹或上传一个参考音")

        alignment_problem: Dict[str, Any] = {}
        try:
            text, lang, alignment_mode = _alignment_request(payload, "none")
        except M27InputError as exc:
            text, lang, alignment_mode = "", "auto", "none"
            alignment_problem = {"alignment_error": exc.detail}

        self.ensure_tt3_imports()
        from kf_ipa_synth.m27_contract import M27_NAMES

        t0 = time.perf_counter()
        try:
            wav_16k = _decode_input_audio(payload)
            spk_wav_16k: Optional[np.ndarray] = None
            if (synth_mode in ("neural", "both", "auto") or spk_b64) and isinstance(spk_b64, str) and spk_b64:
                spk_wav_16k = _decode_speaker_audio(spk_b64)
        except M27InputError as exc:
            return {"ok": False, "error": exc.detail}

        n_frames = len(wav_16k) // WAVLM_HOP_SAMPLES
        wav_16k = np.ascontiguousarray(wav_16k[: n_frames * WAVLM_HOP_SAMPLES], dtype=np.float32)
        dur_sec = round(len(wav_16k) / float(SAMPLE_RATE_16K), 3)

        try:
            with self._invert_lock:
                analysis, dev_str = analyze_waveform_onnx(
                    wav_16k,
                    text=text,
                    lang=lang,
                    alignment_mode="none" if synth_mode == "glottis" else alignment_mode,
                    device=str(req_dev),
                )
                self._loaded_device = dev_str
        except ModelUnloadedError as exc:
            return {"ok": False, "error": {"code": exc.code, "model": exc.model_name, "hint": exc.hint}}
        except (FileNotFoundError, ImportError):
            return {"ok": False, "error": {"code": "model_unavailable", "hint": "本地 Vox2Align-Lite v2 模型或依赖不可用"}}
        if not analysis.get("ok"):
            raise ValueError(analysis.get("error", "Vox2Align 分析失败"))

        m27_dpa = np.asarray(analysis["m27_phys"], dtype=np.float32)
        alignment = alignment_problem or _alignment_result(analysis)
        m27_pa = m27_dpa.copy()
        m27_pa[:, 18] = m27_dpa[:, 18] / 10.0

        if synth_mode == "glottis":
            return {
                "ok": True,
                "device_effective": "cuda" if "cuda" in dev_str else "cpu",
                "glottis_50hz_pa": np.round(m27_pa[:, 17:], 4).tolist(),
                "wall_seconds": round(time.perf_counter() - t0, 2),
            }

        anim = self._extract_anim(m27_dpa, fps=fps)
        audio_gain = payload.get("audio_gain")
        vtl_wav = None if synth_mode in ("animation", "neural") else self._synthesize_vtl_from_m27(
            m27_dpa, tube_hz=tube_hz, audio_gain=audio_gain,
        )

        neural_b64: Optional[str] = None
        if synth_mode in ("neural", "both", "auto") or spk_b64:
            eff_spk = None if voice_profile else (spk_wav_16k if spk_wav_16k is not None else wav_16k)
            try:
                neural_wav, neural_dev = self._synthesize_neural(m27_dpa, eff_spk, str(req_dev), audio_gain=audio_gain)
                neural_b64 = base64.b64encode(neural_wav).decode("ascii")
            except ModelUnloadedError as exc:
                return {"ok": False, "error": {"code": exc.code, "model": exc.model_name, "hint": exc.hint}}
        else:
            neural_dev = dev_str

        act = (m27_pa[:, 18] > 180.0) & (m27_pa[:, 23] > 0.25)
        rows = m27_pa[act] if np.any(act) else m27_pa
        summary = (
            f"F0均值 {float(np.mean(rows[:, 17])):.0f} Hz · "
            f"PR {float(np.mean(rows[:, 18])):.0f} Pa · "
            f"XB {float(np.mean(rows[:, 19])):.3f}/XT {float(np.mean(rows[:, 20])):.3f} · "
            f"CA {float(np.mean(rows[:, 21])):.3f}"
        )

        effective_device = "cuda" if ("cuda" in dev_str or "cuda" in neural_dev) else "cpu"
        return {
            "ok": True,
            **alignment,
            "job_id": f"m27_{int(time.time() * 1000)}",
            "dur_sec": dur_sec,
            "device_effective": effective_device,
            "fps_hz": 50,
            "m27_names": list(M27_NAMES),
            "m27_50hz_pa": np.round(m27_pa, 4).tolist(),
            "tract_glottis_anim": anim,
            **({"vtl_48k_wav_base64": base64.b64encode(vtl_wav).decode("ascii")} if vtl_wav else {}),
            **({"neural_16k_wav_base64": neural_b64} if neural_b64 else {}),
            "glottis_summary": summary,
            **({"voice_profile": voice_profile} if neural_b64 and voice_profile else {}),
            "provenance": {
                "inversion_note": "反演轨迹为 Vox2Tract-Lite M27 模型候选解释，非实测器官运动",
                "physical_badge": "物理管段重合成 (VTL 2.4)",
                **({"neural_badge": "神经声码器渲染 (Tract2Vox-Lite ONNX)"} if neural_b64 else {}),
            },
            "wall_seconds": round(time.perf_counter() - t0, 2),
        }

    def resynthesize(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        raw_rows = payload.get("m27_50hz_pa") if payload.get("m27_50hz_pa") is not None else payload.get("trajectory_pa")
        synth_mode = payload.get("synth_mode", "both")
        if synth_mode not in ("vtl", "neural", "both"):
            return validation_error("synth_mode", "synth_mode 须为 vtl、neural 或 both")
        f0_bounds = (40.0, 600.0) if synth_mode in ("vtl", "both") else (None, None)
        arr_pa, err = validate_m27_pa(
            raw_rows,
            field="m27_50hz_pa",
            min_frames=1,
            max_frames=3000,
            f0_min=f0_bounds[0],
            f0_max=f0_bounds[1],
        )
        if err:
            if synth_mode in ("vtl", "both") and err["error"].get("code") == "out_of_range" and "[17]" in str(err["error"].get("field", "")):
                err["error"]["hint"] = (
                    f"{err['error']['hint']}（VTL 2.4 物理声门原生范围仅支持 40–600 Hz；"
                    "超宽域基频请切换为 Tract2Vox-Lite 神经合成）"
                )
            return err
        assert arr_pa is not None
        req_dev = payload.get("device", "cpu")
        if synth_mode in ("neural", "both"):
            dev_err = self._validate_requested_device(req_dev)
            if dev_err:
                return dev_err
        elif req_dev not in ("cpu", "cuda"):
            return validation_error("device", "请选择本地 CPU 或 CUDA GPU")

        fps = payload.get("fps", 25)
        if type(fps) is not int or not 5 <= fps <= 50:
            return out_of_range_error("fps", fps, 5, 50, "fps")
        tube_hz = payload.get("tube_hz", 100)
        if type(tube_hz) is not int or tube_hz not in (50, 100, 200):
            return validation_error("tube_hz", "tube_hz 须为 50、100 或 200")

        spk_b64 = payload.get("speaker_ref_wav_base64") or payload.get("speaker_ref_base64")
        voice_profile = payload.get("speaker_profile")
        if voice_profile is not None and (voice_profile != DEFAULT_VOICE_ID or spk_b64):
            return validation_error("speaker_profile", "请选择本机讲解声纹或上传一个参考音")

        spk_wav: Optional[np.ndarray] = None
        if synth_mode in ("neural", "both") and isinstance(spk_b64, str) and spk_b64:
            try:
                spk_wav = _decode_speaker_audio(spk_b64)
            except M27InputError as exc:
                return {"ok": False, "error": exc.detail}

        arr_dpa = arr_pa.copy()
        arr_dpa[:, 18] = arr_pa[:, 18] * 10.0

        out: Dict[str, Any] = {
            "ok": True,
            "device_effective": "cpu",
            "tract_glottis_anim": self._extract_anim(arr_dpa, fps=fps),
        }
        if synth_mode in ("vtl", "both"):
            vtl_wav = self._synthesize_vtl_from_m27(arr_dpa, tube_hz=tube_hz, audio_gain=payload.get("audio_gain"))
            out["vtl_48k_wav_base64"] = base64.b64encode(vtl_wav).decode("ascii")
        if synth_mode in ("neural", "both"):
            try:
                neural_wav, actual = self._synthesize_neural(arr_dpa, spk_wav, str(req_dev), audio_gain=payload.get("audio_gain"))
            except ModelUnloadedError as exc:
                return {"ok": False, "error": {"code": exc.code, "model": exc.model_name, "hint": exc.hint}}
            out["neural_16k_wav_base64"] = base64.b64encode(neural_wav).decode("ascii")
            out["device_effective"] = "cuda" if "cuda" in actual else "cpu"
            if voice_profile:
                out["voice_profile"] = voice_profile

        out["source_badge"] = (
            "物理 + 神经双通道对比"
            if synth_mode == "both"
            else ("神经声码器渲染 (Tract2Vox-Lite ONNX)" if synth_mode == "neural" else "物理管段通道 (VTL 2.4)")
        )
        return out

    def neural_reference_audio(self, rows_pa, speaker_path: Path) -> bytes:
        native, err = validate_m27_pa(rows_pa, field="m27_50hz_pa", min_frames=1, max_frames=3000)
        if err:
            raise ValueError(err["error"]["hint"])
        assert native is not None
        native = native.copy()
        native[:, 18] *= 10.0
        spk_wav = ofr.load_audio_16k(speaker_path, max_duration_sec=30.0)
        wav_bytes, _ = self._synthesize_neural(native, spk_wav, self._preferred_vocoder_device(), audio_gain="peak")
        return wav_bytes
