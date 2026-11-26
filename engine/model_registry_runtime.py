"""Unified ONNX Runtime hot-plug registry, contract validator, and external model mounter.

Manages all 9 local models in pure ONNX Runtime (zero PyTorch dependency):
  - Per-slot hot load (warm session into RAM) and hot unload (drop session & disable slot)
  - External `.onnx` file mounting (by local filesystem path or uploaded bytes)
  - External folder scanning & batch mounting (by manifest, filename pattern, or IO contract auto-match)
  - Strict ONNX input/output tensor contract validation before activating any external model
"""
from __future__ import annotations

from dataclasses import dataclass
import gc
import json
import os
from pathlib import Path
import re
import threading
import time
from typing import Any, Dict, List, Optional, Sequence, Tuple

import onnxruntime as ort

ENGINE_DIR = Path(__file__).resolve().parent
REPO_ROOT = ENGINE_DIR.parent
TT3_ROOT = ENGINE_DIR / "model_bundle"
CACHE_DIR = REPO_ROOT / ".cache"
REGISTRY_STATE_PATH = CACHE_DIR / "local-model-registry.json"
CUSTOM_MODELS_DIR = CACHE_DIR / "custom-models"

MAX_EXTERNAL_ONNX_BYTES = 256 * 1024 * 1024  # 256 MiB safety cap

# Adaptive CPU thread allocation: avoid oversubscribing hybrid P/E cores while scaling up heavy models.
CPU_CORES = max(1, os.cpu_count() or 4)
AUTO_THREADS_MICRO = 1
AUTO_THREADS_LIGHT = min(4, max(2, CPU_CORES // 4))
AUTO_THREADS_HEAVY = min(8, max(2, CPU_CORES // 2))
PARALLEL_CHUNK_WORKERS = 2 if CPU_CORES >= 8 else 1
PARALLEL_WORKER_THREADS = min(4, max(2, CPU_CORES // max(2, PARALLEL_CHUNK_WORKERS * 2)))


class ModelUnloadedError(RuntimeError):
    """Raised when an inference request targets a model slot explicitly unloaded by the user."""

    def __init__(self, model_name: str, hint: Optional[str] = None) -> None:
        msg = hint or f"模型 {model_name} 当前已卸载，请先在「设置 → 声学引擎与模型」中点击装载。"
        super().__init__(msg)
        self.model_name = model_name
        self.code = "model_unloaded"
        self.hint = msg


class ModelContractError(ValueError):
    """Raised when a candidate external ONNX model violates a slot's IO tensor contract."""


@dataclass(frozen=True)
class TensorSpec:
    name: str
    rank: int
    dtype: str  # e.g. 'tensor(float)', 'tensor(int64)', 'tensor(double)'
    fixed_dims: Tuple[Tuple[int, int], ...] = ()  # pairs of (axis, expected_size)


@dataclass(frozen=True)
class ModelSlotSpec:
    name: str
    slug: str
    rel_path: str
    fallback_params: int
    role: str
    dtype_detail: str
    threads: int
    inputs: Tuple[TensorSpec, ...]
    outputs: Tuple[TensorSpec, ...]
    filename_patterns: Tuple[str, ...]
    optional_fallback_hint: str = ""
    contract_summary: str = ""


MODEL_SLOTS: Tuple[ModelSlotSpec, ...] = (
    ModelSlotSpec(
        name="Vox2Tract-Lite",
        slug="vox2tract_lite",
        rel_path="models/Vox2Tract-Lite/vox2tract_lite.onnx",
        fallback_params=7642458,
        role="16 kHz 语音反演为 50 Hz 27 维声道与声门动态轨迹",
        dtype_detail="ONNX",
        threads=AUTO_THREADS_HEAVY,
        inputs=(
            TensorSpec("mel_feats", 3, "tensor(float)", ((2, 163),)),
            TensorSpec("vq_cues", 3, "tensor(float)", ((2, 3),)),
            TensorSpec("f0_norm", 2, "tensor(float)"),
        ),
        outputs=(
            TensorSpec("tract17", 3, "tensor(float)", ((2, 17),)),
            TensorSpec("pr1", 3, "tensor(float)", ((2, 1),)),
            TensorSpec("glot8", 3, "tensor(float)", ((2, 8),)),
            TensorSpec("h_backbone", 3, "tensor(float)", ((2, 192),)),
        ),
        filename_patterns=("vox2tract", "inverter", "m27_invert"),
        contract_summary="(B,T,163)+(B,T,3)+(B,T) -> tract17, pr1, glot8, h192",
    ),
    ModelSlotSpec(
        name="Vox2Align-Lite v2",
        slug="vox2align_lite_v2",
        rel_path="models/Vox2Align-Lite/vox2align_lite_v2.onnx",
        fallback_params=4328527,
        role="按参考文本或识别结果精准定位音节与音素边界",
        dtype_detail="ONNX",
        threads=AUTO_THREADS_HEAVY,
        inputs=(
            TensorSpec("mel_feats", 3, "tensor(float)", ((2, 163),)),
            TensorSpec("h_backbone", 3, "tensor(float)", ((2, 192),)),
            TensorSpec("m27_norm", 3, "tensor(float)", ((2, 27),)),
        ),
        outputs=(
            TensorSpec("zh_syl_ctc_logits", 3, "tensor(float)", ((2, 415),)),
            TensorSpec("phone_frame_logits", 3, "tensor(float)", ((2, 65),)),
            TensorSpec("phone_ctc_logits", 3, "tensor(float)", ((2, 65),)),
            TensorSpec("boundary_logits", 3, "tensor(float)", ((2, 2),)),
            TensorSpec("speech_mask_logit", 2, "tensor(float)"),
            TensorSpec("tone_logits", 3, "tensor(float)", ((2, 8),)),
            TensorSpec("lang_logits", 3, "tensor(float)", ((2, 3),)),
        ),
        filename_patterns=("vox2align", "align_v2", "aligner"),
        contract_summary="(B,T,163)+(B,T,192)+(B,T,27) -> 7 alignment heads",
    ),
    ModelSlotSpec(
        name="IPA2Tract-Lite",
        slug="ipa2tract_lite",
        rel_path="models/IPA2Tract-Lite/ipa2tract_lite.onnx",
        fallback_params=4228826,
        role="音标关键帧之间的连续协同发音构音轨迹规划",
        dtype_detail="ONNX",
        threads=AUTO_THREADS_HEAVY,
        inputs=(
            TensorSpec("cond", 3, "tensor(float)", ((2, 111),)),
            TensorSpec("x_base", 3, "tensor(float)", ((2, 26),)),
            TensorSpec("alpha", 1, "tensor(float)"),
        ),
        outputs=(
            TensorSpec("x_hat", 3, "tensor(float)", ((2, 26),)),
        ),
        filename_patterns=("ipa2tract", "kf2tract", "keyframe_tract"),
        optional_fallback_hint="卸载后协同构音将退回基础 qTA / 手工轨迹",
        contract_summary="(B,T,111)+(B,T,26)+(1,) -> (B,T,26)",
    ),
    ModelSlotSpec(
        name="Tract2Vox-Lite",
        slug="tract2vox_lite",
        rel_path="models/Tract2Vox-Lite/tract2vox_lite.onnx",
        fallback_params=3719666,
        role="27 维声道轨迹与 512 维声纹联合驱动的高保真神经声码器",
        dtype_detail="ONNX",
        threads=AUTO_THREADS_HEAVY,
        inputs=(
            TensorSpec("m27_norm", 3, "tensor(float)", ((2, 27),)),
            TensorSpec("spk_seq", 3, "tensor(float)", ((2, 512),)),
            TensorSpec("env_rand", 3, "tensor(float)", ((1, 2),)),
            TensorSpec("n_wb", 3, "tensor(float)", ((1, 1),)),
        ),
        outputs=(
            TensorSpec("wav_16k", 2, "tensor(float)"),
        ),
        filename_patterns=("tract2vox", "vocoder", "hifigan"),
        contract_summary="(B,T,27)+(B,T,512)+noise -> wav_16k (B,320*T)",
    ),
    ModelSlotSpec(
        name="Vox2Spk-Lite",
        slug="vox2spk_lite",
        rel_path="models/Vox2Spk-Lite/vox2spk_lite.onnx",
        fallback_params=2901440,
        role="从参考录音提取跨语种解耦的 512 维说话人声纹表征",
        dtype_detail="ONNX",
        threads=AUTO_THREADS_HEAVY,
        inputs=(
            TensorSpec("log_mel", 3, "tensor(float)", ((1, 80),)),
        ),
        outputs=(
            TensorSpec("spk_emb", 2, "tensor(float)", ((1, 512),)),
        ),
        filename_patterns=("vox2spk", "spk_enc", "speaker"),
        contract_summary="(B,80,T) -> (B,512) L2-norm",
    ),
    ModelSlotSpec(
        name="DPDFNet",
        slug="dpdfnet",
        rel_path="ptb/resources/neural/dpdfnet2_48khz_hr.onnx",
        fallback_params=2582352,
        role="实录语料前端实时语音增强与宽带底噪抑制",
        dtype_detail="ONNX",
        threads=AUTO_THREADS_MICRO,
        inputs=(
            TensorSpec("spec", 4, "tensor(float)", ((2, 481), (3, 2))),
            TensorSpec("state_in", 1, "tensor(float)"),
        ),
        outputs=(
            TensorSpec("spec_e", 4, "tensor(float)", ((2, 481), (3, 2))),
            TensorSpec("state_out", 1, "tensor(float)"),
        ),
        filename_patterns=("dpdfnet", "denoise"),
        contract_summary="(1,1,481,2)+state -> (1,1,481,2)+state",
    ),
    ModelSlotSpec(
        name="Text2Prosody-Lite",
        slug="text2prosody_lite",
        rel_path="models/Text2Prosody-Lite/text2prosody_lite.onnx",
        fallback_params=1980455,
        role="普通话与英语文本的音素时长及自然基频轮廓预测",
        dtype_detail="ONNX",
        threads=AUTO_THREADS_LIGHT,
        inputs=(
            TensorSpec("phon_feat", 3, "tensor(float)", ((2, 22),)),
            TensorSpec("pos_struct", 3, "tensor(float)", ((2, 10),)),
            TensorSpec("lang_id", 2, "tensor(int64)"),
            TensorSpec("tone_stress_id", 2, "tensor(int64)"),
            TensorSpec("punct_id", 2, "tensor(int64)"),
            TensorSpec("role_id", 2, "tensor(int64)"),
        ),
        outputs=(
            TensorSpec("log_dur", 2, "tensor(float)"),
            TensorSpec("f0_st3", 3, "tensor(float)", ((2, 3),)),
            TensorSpec("voiced_logit", 2, "tensor(float)"),
            TensorSpec("pause_logit", 2, "tensor(float)"),
            TensorSpec("log_pause_dur", 2, "tensor(float)"),
        ),
        filename_patterns=("text2prosody", "prosody"),
        optional_fallback_hint="卸载后文本编译将自动改用规则韵律与时长",
        contract_summary="6 phone tensors (B,L,...) -> dur, f0_st3, voiced, pause",
    ),
    ModelSlotSpec(
        name="Tract2Area-Proxy",
        slug="tract2area_proxy",
        rel_path="models/IPA2Tract-Lite/tract2area_proxy.onnx",
        fallback_params=228486,
        role="关键帧规划阶段的可微 6 维声道关键区面积代理（全口腔、双唇、舌冠、舌背、咽腔最小截面积与腭咽口面积）",
        dtype_detail="ONNX",
        threads=AUTO_THREADS_LIGHT,
        inputs=(
            TensorSpec("tract17_norm", 3, "tensor(float)", ((2, 17),)),
        ),
        outputs=(
            TensorSpec("area_cm2", 3, "tensor(float)", ((2, 6),)),
        ),
        filename_patterns=("tract2area", "tube_proxy", "area_proxy"),
        optional_fallback_hint="卸载后跳过局部收窄面积代理检查",
        contract_summary="(B,T,17) -> (B,T,6) cm²",
    ),
    ModelSlotSpec(
        name="SwiftF0",
        slug="swiftf0",
        rel_path="ptb/resources/neural/swift-f0-0.3.0.onnx",
        fallback_params=29861,
        role="超轻量低延迟实测基频轨迹提取与清浊音判别",
        dtype_detail="ONNX",
        threads=AUTO_THREADS_MICRO,
        inputs=(
            TensorSpec("audio", 2, "tensor(float)"),
            TensorSpec("fmin", 0, "tensor(float)"),
            TensorSpec("fmax", 0, "tensor(float)"),
        ),
        outputs=(
            TensorSpec("pitch", 2, "tensor(double)"),
            TensorSpec("confidence", 2, "tensor(float)"),
        ),
        filename_patterns=("swift-f0", "swift_f0", "swiftf0"),
        contract_summary="audio(1,L)+fmin+fmax -> pitch, confidence",
    ),
)

SLOTS_BY_NAME: Dict[str, ModelSlotSpec] = {s.name: s for s in MODEL_SLOTS}
SLOTS_BY_SLUG: Dict[str, ModelSlotSpec] = {s.slug: s for s in MODEL_SLOTS}

_ONNX_PROTO_CACHE: Dict[Tuple[str, int, int], Tuple[int, str]] = {}


def _read_varint(buf: memoryview, pos: int) -> Tuple[int, int]:
    result = 0
    shift = 0
    n = len(buf)
    while pos < n:
        b = buf[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            return result, pos
        shift += 7
    return result, pos


def inspect_onnx_proto_stats(path: Path, fallback_params: int) -> Tuple[int, str]:
    """Count initializer elements and detect dominant weight dtype directly from ONNX protobuf bytes."""
    try:
        st = path.stat()
        key = (str(path), st.st_size, st.st_mtime_ns)
        cached = _ONNX_PROTO_CACHE.get(key)
        if cached is not None:
            return cached
        raw = memoryview(path.read_bytes())
        pos = 0
        end = len(raw)
        total = 0
        dtype_counts: Dict[int, int] = {}
        while pos < end:
            tag, pos = _read_varint(raw, pos)
            field_no, wire = tag >> 3, tag & 7
            if wire == 0:
                _, pos = _read_varint(raw, pos)
            elif wire == 1:
                pos += 8
            elif wire == 5:
                pos += 4
            elif wire == 2:
                length, pos = _read_varint(raw, pos)
                sub_end = min(end, pos + length)
                if field_no == 7:  # ModelProto.graph
                    g_pos = pos
                    while g_pos < sub_end:
                        g_tag, g_pos = _read_varint(raw, g_pos)
                        g_field, g_wire = g_tag >> 3, g_tag & 7
                        if g_wire == 0:
                            _, g_pos = _read_varint(raw, g_pos)
                        elif g_wire == 1:
                            g_pos += 8
                        elif g_wire == 5:
                            g_pos += 4
                        elif g_wire == 2:
                            t_len, g_pos = _read_varint(raw, g_pos)
                            t_end = min(sub_end, g_pos + t_len)
                            if g_field == 5:  # GraphProto.initializer (TensorProto)
                                dims: List[int] = []
                                data_type = 0
                                t_pos = g_pos
                                while t_pos < t_end:
                                    t_tag, t_pos = _read_varint(raw, t_pos)
                                    t_field, t_wire = t_tag >> 3, t_tag & 7
                                    if t_wire == 0:
                                        v, t_pos = _read_varint(raw, t_pos)
                                        if t_field == 1:
                                            dims.append(v)
                                        elif t_field == 2:
                                            data_type = int(v)
                                    elif t_wire == 1:
                                        t_pos += 8
                                    elif t_wire == 5:
                                        t_pos += 4
                                    elif t_wire == 2:
                                        d_len, t_pos = _read_varint(raw, t_pos)
                                        d_end = min(t_end, t_pos + d_len)
                                        if t_field == 1:
                                            while t_pos < d_end:
                                                v, t_pos = _read_varint(raw, t_pos)
                                                dims.append(v)
                                        t_pos = d_end
                                    else:
                                        break
                                elem = 1
                                for d in dims:
                                    elem *= max(1, int(d))
                                total += elem
                                if data_type:
                                    dtype_counts[data_type] = dtype_counts.get(data_type, 0) + elem
                            g_pos = t_end
                        else:
                            break
                pos = sub_end
            else:
                break
        params = total if total > 0 else fallback_params
        # TensorProto DataType: 1=FLOAT, 2=UINT8, 3=INT8, 10=FLOAT16
        n_int8 = dtype_counts.get(2, 0) + dtype_counts.get(3, 0)
        n_fp16 = dtype_counts.get(10, 0)
        n_fp32 = dtype_counts.get(1, 0)
        if n_int8 > max(n_fp16, n_fp32) * 0.5 and n_int8 > 0:
            dtype_label = "ONNX INT8"
        elif n_fp16 > n_fp32 * 0.5 and n_fp16 > 0:
            dtype_label = "ONNX FP16"
        else:
            dtype_label = "ONNX FP32"
        out = (params, dtype_label)
        _ONNX_PROTO_CACHE[key] = out
        return out
    except OSError:
        return fallback_params, "ONNX"


def _check_tensor_list(
    actual: Sequence[Any],
    expected: Sequence[TensorSpec],
    kind: str,
    model_name: str,
) -> Optional[str]:
    if len(actual) != len(expected):
        return f"{model_name} {kind}数量不匹配：期望 {len(expected)} 项（{[e.name for e in expected]}），实际 {len(actual)} 项"
    for idx, (act, exp) in enumerate(zip(actual, expected)):
        if act.name != exp.name:
            return f"{model_name} 第 {idx + 1} 个{kind}名称不匹配：期望 {exp.name}，实际 {act.name}"
        if exp.dtype and act.type != exp.dtype:
            # Allow float/double interchangeably for pitch output just in case
            if not ({act.type, exp.dtype} <= {"tensor(float)", "tensor(double)"} and exp.name == "pitch"):
                return f"{model_name} {kind} `{exp.name}` 类型不匹配：期望 {exp.dtype}，实际 {act.type}"
        act_shape = list(act.shape) if act.shape is not None else []
        if len(act_shape) != exp.rank:
            return f"{model_name} {kind} `{exp.name}` 维度阶数不匹配：期望 {exp.rank}D，实际 {len(act_shape)}D ({act_shape})"
        for axis, exp_dim in exp.fixed_dims:
            got = act_shape[axis]
            if isinstance(got, int) and got != exp_dim:
                return f"{model_name} {kind} `{exp.name}` 第 {axis} 维大小不匹配：期望 {exp_dim}，实际 {got}"
    return None


def validate_onnx_session_contract(session: ort.InferenceSession, slot: ModelSlotSpec) -> None:
    err = _check_tensor_list(session.get_inputs(), slot.inputs, "输入", slot.name)
    if err:
        raise ModelContractError(err)
    err = _check_tensor_list(session.get_outputs(), slot.outputs, "输出", slot.name)
    if err:
        raise ModelContractError(err)


def ort_cuda_available() -> bool:
    try:
        return "CUDAExecutionProvider" in ort.get_available_providers()
    except Exception:
        return False


def _create_ort_session(path: Path, *, threads: int, device: str = "cpu") -> Tuple[ort.InferenceSession, str]:
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = max(1, int(threads))
    opts.inter_op_num_threads = 1
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    avail = ort.get_available_providers()
    if device == "cuda" and "CUDAExecutionProvider" in avail:
        providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
    else:
        providers = ["CPUExecutionProvider"]
    sess = ort.InferenceSession(str(path), sess_options=opts, providers=providers)
    active_providers = sess.get_providers()
    effective = active_providers[0] if active_providers else "CPUExecutionProvider"
    return sess, effective


def _sanitize_filename(name: str) -> str:
    stem = Path(name).name
    stem = re.sub(r"[^A-Za-z0-9._\-\u4e00-\u9fff]+", "_", stem).strip("._")
    if not stem:
        stem = "custom_model.onnx"
    if not stem.lower().endswith(".onnx"):
        stem += ".onnx"
    return stem[:96]


class LocalModelManager:
    """Thread-safe hot-plug manager for all 9 local ONNX models."""

    def __init__(self, state_path: Path = REGISTRY_STATE_PATH) -> None:
        self._lock = threading.RLock()
        self._state_path = Path(state_path)
        self._enabled: Dict[str, bool] = {s.name: True for s in MODEL_SLOTS}
        self._external_path: Dict[str, Optional[Path]] = {s.name: None for s in MODEL_SLOTS}
        self._external_label: Dict[str, Optional[str]] = {s.name: None for s in MODEL_SLOTS}
        self._sessions: Dict[Tuple[str, str], ort.InferenceSession] = {}
        self._parallel_sessions: Dict[Tuple[str, str], List[ort.InferenceSession]] = {}
        self._active_provider: Dict[str, str] = {}
        self._load_ms: Dict[str, Optional[float]] = {s.name: None for s in MODEL_SLOTS}
        self._load_persisted_state()

    def _load_persisted_state(self) -> None:
        if not self._state_path.is_file():
            return
        try:
            raw = json.loads(self._state_path.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            return
        slots_cfg = raw.get("slots") if isinstance(raw, dict) else None
        if not isinstance(slots_cfg, dict):
            return
        for name, cfg in slots_cfg.items():
            if name not in SLOTS_BY_NAME or not isinstance(cfg, dict):
                continue
            if isinstance(cfg.get("enabled"), bool):
                self._enabled[name] = cfg["enabled"]
            ext = cfg.get("external_path")
            if isinstance(ext, str) and ext.strip():
                p = Path(ext.strip())
                if p.is_file():
                    self._external_path[name] = p
                    lbl = cfg.get("external_label")
                    self._external_label[name] = str(lbl) if isinstance(lbl, str) and lbl.strip() else p.name

    def _save_persisted_state(self) -> None:
        try:
            self._state_path.parent.mkdir(parents=True, exist_ok=True)
            payload = {
                "schema": "vocalcut_local_model_registry_v1",
                "slots": {
                    s.name: {
                        "enabled": bool(self._enabled[s.name]),
                        "external_path": str(self._external_path[s.name]) if self._external_path[s.name] is not None else None,
                        "external_label": self._external_label[s.name],
                    }
                    for s in MODEL_SLOTS
                },
            }
            tmp = self._state_path.with_suffix(".tmp")
            tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            tmp.replace(self._state_path)
        except OSError:
            pass

    @staticmethod
    def resolve_slot(name_or_slug: str) -> ModelSlotSpec:
        key = (name_or_slug or "").strip()
        if key in SLOTS_BY_NAME:
            return SLOTS_BY_NAME[key]
        if key in SLOTS_BY_SLUG:
            return SLOTS_BY_SLUG[key]
        raise ValueError(f"未知的本地模型槽位：{name_or_slug}")

    def active_path(self, name: str) -> Path:
        slot = self.resolve_slot(name)
        with self._lock:
            ext = self._external_path.get(slot.name)
            if ext is not None:
                return ext
            return TT3_ROOT / slot.rel_path

    def is_enabled(self, name: str) -> bool:
        slot = self.resolve_slot(name)
        with self._lock:
            return bool(self._enabled.get(slot.name, True))

    def is_in_memory(self, name: str) -> bool:
        slot = self.resolve_slot(name)
        with self._lock:
            return any(k[0] == slot.name for k in self._sessions)

    def _drop_sessions_locked(self, name: str) -> None:
        keys = [k for k in self._sessions if k[0] == name]
        for k in keys:
            self._sessions.pop(k, None)
        pkeys = [k for k in self._parallel_sessions if k[0] == name]
        for k in pkeys:
            self._parallel_sessions.pop(k, None)
        self._active_provider.pop(name, None)
        self._load_ms[name] = None
        if keys or pkeys:
            gc.collect()

    def model_version_key(self, name: str) -> str:
        """Return a stable fingerprint of the active `.onnx` file so chunk caches auto-invalidate on hot-swap."""
        path = self.active_path(name)
        try:
            st = path.stat()
            return f"{name}|{path}|{st.st_size}|{st.st_mtime_ns}"
        except OSError:
            return f"{name}|{path}|missing"

    def require_parallel_sessions(
        self,
        name: str,
        count: int = PARALLEL_CHUNK_WORKERS,
        *,
        device: str = "cpu",
    ) -> Tuple[List[ort.InferenceSession], str]:
        """Return `count` independent ORT sessions sized for concurrent multi-chunk CPU synthesis."""
        slot = self.resolve_slot(name)
        n = max(1, int(count))
        if n == 1:
            sess, actual = self.require_session(slot.name, device=device)
            return [sess], actual
        dev = "cuda" if device == "cuda" else "cpu"
        with self._lock:
            if not self._enabled.get(slot.name, True):
                raise ModelUnloadedError(slot.name)
            cache_key = (slot.name, dev)
            existing = self._parallel_sessions.get(cache_key)
            if existing is not None and len(existing) >= n:
                prov = self._active_provider.get(slot.name, "CPUExecutionProvider")
                return list(existing[:n]), ("cuda" if "CUDA" in prov else "cpu")
            path = self.active_path(slot.name)
            if not path.is_file():
                raise FileNotFoundError(f"缺少模型文件：{slot.name} ({path.name})")
            worker_threads = min(slot.threads, PARALLEL_WORKER_THREADS)
            sessions: List[ort.InferenceSession] = list(existing or [])
            prov = self._active_provider.get(slot.name, "CPUExecutionProvider")
            while len(sessions) < n:
                s, prov = _create_ort_session(path, threads=worker_threads, device=dev)
                validate_onnx_session_contract(s, slot)
                sessions.append(s)
            self._parallel_sessions[cache_key] = sessions
            self._active_provider[slot.name] = prov
            return list(sessions[:n]), ("cuda" if "CUDA" in prov else "cpu")

    def require_session(self, name: str, *, device: str = "cpu") -> Tuple[ort.InferenceSession, str]:
        """Return an active ORT session for `name`, raising `ModelUnloadedError` if unloaded."""
        slot = self.resolve_slot(name)
        dev = "cuda" if device == "cuda" else "cpu"
        with self._lock:
            if not self._enabled.get(slot.name, True):
                raise ModelUnloadedError(slot.name)
            cache_key = (slot.name, dev)
            sess = self._sessions.get(cache_key)
            if sess is not None:
                prov = self._active_provider.get(slot.name, "CPUExecutionProvider")
                return sess, ("cuda" if "CUDA" in prov else "cpu")
            path = self.active_path(slot.name)
            if not path.is_file():
                raise FileNotFoundError(f"缺少模型文件：{slot.name} ({path.name})")
            t0 = time.perf_counter()
            sess, prov = _create_ort_session(path, threads=slot.threads, device=dev)
            validate_onnx_session_contract(sess, slot)
            self._sessions[cache_key] = sess
            self._active_provider[slot.name] = prov
            self._load_ms[slot.name] = round((time.perf_counter() - t0) * 1000.0, 1)
            return sess, ("cuda" if "CUDA" in prov else "cpu")

    def load_model(self, name: str, *, device: str = "cpu") -> Dict[str, Any]:
        """Hot-load a model slot into memory and mark it enabled."""
        slot = self.resolve_slot(name)
        with self._lock:
            path = self.active_path(slot.name)
            if not path.is_file():
                raise FileNotFoundError(f"无法装载 {slot.name}：权重文件不存在 ({path})")
            self._enabled[slot.name] = True
            self._save_persisted_state()
            self.require_session(slot.name, device=device)
            return self.slot_status(slot.name)

    def unload_model(self, name: str) -> Dict[str, Any]:
        """Hot-unload a model slot from memory and mark it disabled."""
        slot = self.resolve_slot(name)
        with self._lock:
            self._enabled[slot.name] = False
            self._drop_sessions_locked(slot.name)
            self._save_persisted_state()
            return self.slot_status(slot.name)

    def load_all(self, *, device: str = "cpu") -> Dict[str, Any]:
        errors: List[Dict[str, str]] = []
        with self._lock:
            for slot in MODEL_SLOTS:
                try:
                    self.load_model(slot.name, device=device)
                except Exception as exc:
                    errors.append({"name": slot.name, "hint": str(exc)})
            status = self.list_status()
        status["errors"] = errors
        return status

    def unload_all(self) -> Dict[str, Any]:
        with self._lock:
            for slot in MODEL_SLOTS:
                self._enabled[slot.name] = False
                self._drop_sessions_locked(slot.name)
            self._save_persisted_state()
            return self.list_status()

    def mount_external_file(
        self,
        name: str,
        file_path: str | Path,
        *,
        label: Optional[str] = None,
        device: str = "cpu",
    ) -> Dict[str, Any]:
        """Validate & hot-swap a single slot to an external `.onnx` file on disk."""
        slot = self.resolve_slot(name)
        path = Path(file_path).expanduser()
        if not path.is_file():
            raise FileNotFoundError(f"找不到指定的 ONNX 文件：{path}")
        if path.suffix.lower() != ".onnx":
            raise ModelContractError("外部模型仅支持标准 .onnx 文件")
        size = path.stat().st_size
        if size <= 1024 or size > MAX_EXTERNAL_ONNX_BYTES:
            raise ModelContractError(f"ONNX 文件体积 ({size} B) 超出合理范围（1 KB – 256 MB）")

        t0 = time.perf_counter()
        try:
            sess, prov = _create_ort_session(path, threads=slot.threads, device=device)
            validate_onnx_session_contract(sess, slot)
        except ModelContractError:
            raise
        except Exception as exc:
            raise ModelContractError(f"ONNX Runtime 无法加载该文件：{exc}") from exc
        load_ms = round((time.perf_counter() - t0) * 1000.0, 1)

        with self._lock:
            self._drop_sessions_locked(slot.name)
            self._external_path[slot.name] = path.resolve()
            self._external_label[slot.name] = (label or path.name).strip()
            self._enabled[slot.name] = True
            self._sessions[(slot.name, "cuda" if "CUDA" in prov else "cpu")] = sess
            self._active_provider[slot.name] = prov
            self._load_ms[slot.name] = load_ms
            self._save_persisted_state()
            return self.slot_status(slot.name)

    def mount_external_bytes(
        self,
        name: str,
        filename: str,
        raw_bytes: bytes,
        *,
        device: str = "cpu",
    ) -> Dict[str, Any]:
        """Stage uploaded `.onnx` bytes into `.cache/custom-models/<slug>/`, validate, and hot-swap."""
        slot = self.resolve_slot(name)
        if not raw_bytes or len(raw_bytes) <= 1024:
            raise ModelContractError("上传的 ONNX 文件内容过小或为空")
        if len(raw_bytes) > MAX_EXTERNAL_ONNX_BYTES:
            raise ModelContractError("上传的 ONNX 文件超过 256 MiB 上限")
        clean = _sanitize_filename(filename)
        dst_dir = CUSTOM_MODELS_DIR / slot.slug
        dst_dir.mkdir(parents=True, exist_ok=True)
        tmp_path = dst_dir / f".staging_{int(time.time() * 1000)}_{clean}"
        final_path = dst_dir / clean
        tmp_path.write_bytes(raw_bytes)
        try:
            t0 = time.perf_counter()
            sess, prov = _create_ort_session(tmp_path, threads=slot.threads, device=device)
            validate_onnx_session_contract(sess, slot)
            load_ms = round((time.perf_counter() - t0) * 1000.0, 1)
            # Release staging session handle before renaming on Windows
            del sess
            gc.collect()
            tmp_path.replace(final_path)
            sess, prov = _create_ort_session(final_path, threads=slot.threads, device=device)
        except Exception as exc:
            tmp_path.unlink(missing_ok=True)
            if isinstance(exc, ModelContractError):
                raise
            raise ModelContractError(f"ONNX 模型校验失败：{exc}") from exc

        with self._lock:
            self._drop_sessions_locked(slot.name)
            self._external_path[slot.name] = final_path.resolve()
            self._external_label[slot.name] = clean
            self._enabled[slot.name] = True
            self._sessions[(slot.name, "cuda" if "CUDA" in prov else "cpu")] = sess
            self._active_provider[slot.name] = prov
            self._load_ms[slot.name] = load_ms
            self._save_persisted_state()
            return self.slot_status(slot.name)

    def mount_external_bytes_auto(self, filename: str, raw_bytes: bytes, *, device: str = "cpu") -> Dict[str, Any]:
        """Auto-detect matching slot for uploaded `.onnx` bytes, validate contract, and hot-swap."""
        if not raw_bytes or len(raw_bytes) <= 1024:
            raise ModelContractError("上传的 ONNX 文件内容过小或为空")
        if len(raw_bytes) > MAX_EXTERNAL_ONNX_BYTES:
            raise ModelContractError("上传的 ONNX 文件超过 256 MiB 上限")
        clean = _sanitize_filename(filename)
        CUSTOM_MODELS_DIR.mkdir(parents=True, exist_ok=True)
        tmp_path = CUSTOM_MODELS_DIR / f".probe_{int(time.time() * 1000)}_{clean}"
        tmp_path.write_bytes(raw_bytes)
        try:
            slot, err = self.detect_slot_for_onnx(tmp_path)
            if slot is None:
                raise ModelContractError(err or f"{clean} 与 9 个内置模型槽位契约不匹配")
        finally:
            tmp_path.unlink(missing_ok=True)
        return self.mount_external_bytes(slot.name, clean, raw_bytes, device=device)

    def reset_model(self, name: str, *, reload_if_enabled: bool = True) -> Dict[str, Any]:
        """Restore a slot back to its bundled default `.onnx` model."""
        slot = self.resolve_slot(name)
        with self._lock:
            self._external_path[slot.name] = None
            self._external_label[slot.name] = None
            self._drop_sessions_locked(slot.name)
            self._enabled[slot.name] = True
            self._save_persisted_state()
            if reload_if_enabled and self.active_path(slot.name).is_file():
                self.require_session(slot.name, device="cpu")
            return self.slot_status(slot.name)

    def reset_all(self) -> Dict[str, Any]:
        with self._lock:
            for slot in MODEL_SLOTS:
                self._external_path[slot.name] = None
                self._external_label[slot.name] = None
                self._drop_sessions_locked(slot.name)
                self._enabled[slot.name] = True
            self._save_persisted_state()
            return self.list_status()

    @staticmethod
    def detect_slot_for_onnx(path: Path) -> Tuple[Optional[ModelSlotSpec], Optional[str]]:
        """Auto-match an arbitrary `.onnx` file to a slot by filename first, then by IO contract."""
        lower = path.name.lower()
        ordered: List[ModelSlotSpec] = []
        for slot in MODEL_SLOTS:
            if any(pat in lower for pat in slot.filename_patterns):
                ordered.append(slot)
        for slot in MODEL_SLOTS:
            if slot not in ordered:
                ordered.append(slot)
        try:
            sess, _ = _create_ort_session(path, threads=1, device="cpu")
        except Exception as exc:
            return None, f"无法解析 {path.name}: {exc}"
        first_err: Optional[str] = None
        for slot in ordered:
            try:
                validate_onnx_session_contract(sess, slot)
                return slot, None
            except ModelContractError as exc:
                if first_err is None and any(pat in lower for pat in slot.filename_patterns):
                    first_err = str(exc)
        return None, first_err or f"{path.name} 与 9 个内置模型槽位的输入输出契约均不匹配"

    def scan_and_mount_folder(self, folder: str | Path, *, mount: bool = True) -> Dict[str, Any]:
        """Scan a local directory (up to depth 2) for compatible `.onnx` models and optionally hot-mount them."""
        root = Path(folder).expanduser()
        if not root.is_dir():
            raise FileNotFoundError(f"文件夹不存在：{root}")
        candidates: List[Path] = []
        for item in sorted(root.iterdir()):
            if item.is_file() and item.suffix.lower() == ".onnx":
                candidates.append(item)
            elif item.is_dir():
                for child in sorted(item.iterdir()):
                    if child.is_file() and child.suffix.lower() == ".onnx":
                        candidates.append(child)
        if not candidates:
            raise ValueError(f"目录 {root} 下未找到任何 .onnx 模型文件")

        matched: List[Dict[str, Any]] = []
        unmatched: List[Dict[str, str]] = []
        seen_slots: set[str] = set()
        for onnx_file in candidates:
            slot, err = self.detect_slot_for_onnx(onnx_file)
            if slot is None:
                unmatched.append({"file": onnx_file.name, "reason": err or "契约不匹配"})
                continue
            if slot.name in seen_slots:
                unmatched.append({"file": onnx_file.name, "reason": f"槽位 {slot.name} 已被同目录更靠前文件占用"})
                continue
            seen_slots.add(slot.name)
            rel_label = str(onnx_file.relative_to(root)).replace("\\", "/")
            if mount:
                st = self.mount_external_file(slot.name, onnx_file, label=f"{root.name}/{rel_label}")
                matched.append({"name": slot.name, "file": rel_label, "status": st})
            else:
                matched.append({"name": slot.name, "file": rel_label, "path": str(onnx_file)})

        return {
            "ok": True,
            "folder": str(root.resolve()),
            "mounted_count": len(matched) if mount else 0,
            "matched": matched,
            "unmatched": unmatched,
            "models_state": self.list_status(),
        }

    def slot_status(self, name: str) -> Dict[str, Any]:
        slot = self.resolve_slot(name)
        with self._lock:
            ext = self._external_path.get(slot.name)
            file_path = ext if ext is not None else (TT3_ROOT / slot.rel_path)
            avail = file_path.is_file()
            f_bytes = file_path.stat().st_size if avail else 0
            if avail:
                params, dtype_label = inspect_onnx_proto_stats(file_path, slot.fallback_params)
            else:
                params, dtype_label = slot.fallback_params, slot.dtype_detail
            enabled = bool(self._enabled.get(slot.name, True))
            in_mem = any(k[0] == slot.name for k in self._sessions)
            return {
                "name": slot.name,
                "slug": slot.slug,
                "available": avail,
                "enabled": enabled,
                "loaded": enabled and avail,
                "in_memory": in_mem,
                "source": "external" if ext is not None else "builtin",
                "external_path": str(ext) if ext is not None else None,
                "external_label": self._external_label.get(slot.name) if ext is not None else None,
                "variant": dtype_label.lower().replace(" ", "_"),
                "precision": "ONNX",
                "dtype_detail": dtype_label,
                "file": str(ext) if ext is not None else slot.rel_path,
                "file_bytes": f_bytes,
                "size_mb": round(f_bytes / (1024.0 * 1024.0), 2),
                "params": params,
                "params_m": round(params / 1_000_000.0, 3),
                "role": slot.role,
                "description": slot.role,
                "load_ms": self._load_ms.get(slot.name),
                "provider": self._active_provider.get(slot.name),
                "threads": slot.threads,
                "contract_summary": slot.contract_summary,
                "optional_fallback_hint": slot.optional_fallback_hint,
            }

    def list_status(self) -> Dict[str, Any]:
        with self._lock:
            models_out = [self.slot_status(s.name) for s in MODEL_SLOTS]
        avail_count = sum(1 for m in models_out if m["available"])
        loaded_count = sum(1 for m in models_out if m["loaded"])
        in_memory_count = sum(1 for m in models_out if m["in_memory"])
        external_count = sum(1 for m in models_out if m["source"] == "external")
        total_bytes = sum(int(m["file_bytes"]) for m in models_out)
        total_params = sum(int(m["params"]) for m in models_out)
        return {
            "ok": True,
            "models": models_out,
            "count": len(models_out),
            "available_count": avail_count,
            "loaded_count": loaded_count,
            "in_memory_count": in_memory_count,
            "external_count": external_count,
            "total_bytes": total_bytes,
            "total_file_bytes": total_bytes,
            "total_size_mb": round(total_bytes / (1024.0 * 1024.0), 2),
            "total_params_m": round(total_params / 1_000_000.0, 3),
            "voice": "jingjing-lecture",
            "runtime": "onnxruntime",
            "runtime_version": ort.__version__,
            "runtime_providers": list(ort.get_available_providers()),
            "cuda_available": ort_cuda_available(),
            "cpu_cores": CPU_CORES,
            "adaptive_threads_heavy": AUTO_THREADS_HEAVY,
            "parallel_chunk_workers": PARALLEL_CHUNK_WORKERS,
        }


LOCAL_MODEL_MANAGER = LocalModelManager()
