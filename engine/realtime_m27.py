"""Low-latency sliding-window realtime vocal tract inversion & neural synthesis (zero PyTorch).

Supports independent live toggles:
  - `include_tract_geometry`: solve native JD2 2D sagittal contours + glottis state for the emitted frames
  - `use_timbre_model`: load/cache 512-dim speaker embedding via `Vox2Spk-Lite` (once per reference or session)
  - `synthesize_audio`: synthesize 16 kHz audio via `Tract2Vox-Lite` with 15 ms left overlap for seamless Web Audio crossfade
"""
from __future__ import annotations

import base64
from collections import OrderedDict
import ctypes as C
import hashlib
import io
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import soundfile as sf

from dense_channel import DenseEngineManager, PARTS, _soft_limit_audio, dp
from m27_bridge import DEFAULT_TIMBRE_PROFILE, M27Bridge, M27InputError, _decode_speaker_audio, _m27_to_tract19
from model_registry_runtime import LOCAL_MODEL_MANAGER, ModelUnloadedError
import onnx_frontends as ofr
from onnx_inference import (
    REST_M27_PHYS,
    _pack_m27_norm,
    ensure_pure_numpy_imports,
    extract_speaker_embedding,
    extract_swift_f0_50hz,
    load_speaker_profile_embedding,
    run_vox2tract_chunk,
)

SAMPLE_RATE_16K = 16000
HOP_16K = 320  # 20 ms @ 16 kHz (50 Hz control grid)
LIVE_AUDIO_OVERLAP_16K = 240  # 15 ms @ 16 kHz crossfade overlap
MAX_LIVE_WINDOW_SAMPLES = SAMPLE_RATE_16K * 2  # <= 2.0 s sliding window cap
MAX_LOOKAHEAD_FRAMES = 20
VOCODER_BASE_LEFT_CONTEXT_FRAMES = 10
VOCODER_MAX_LEFT_CONTEXT_FRAMES = 28
VOCODER_MAX_RIGHT_CONTEXT_FRAMES = 18
SILENCE_RMS_THRESHOLD = 0.0075
SPEECH_RMS_FULL = 0.028


class _RealtimeSessionState:
    __slots__ = (
        "last_m27_dpa",
        "has_audio_predecessor",
        "self_spk_emb",
        "self_speech_buf",
        "updated_at",
    )

    def __init__(self) -> None:
        self.last_m27_dpa: np.ndarray = REST_M27_PHYS.copy()
        self.has_audio_predecessor = False
        self.self_spk_emb: Optional[np.ndarray] = None
        self.self_speech_buf: list[np.ndarray] = []
        self.updated_at: float = time.monotonic()


class RealtimeM27Service:
    """Thread-safe pure-ONNX service for near-realtime sliding-window inversion & voice conversion."""

    def __init__(
        self,
        dense_manager: Optional[DenseEngineManager] = None,
        m27_bridge: Optional[M27Bridge] = None,
    ) -> None:
        self._dense = dense_manager or DenseEngineManager()
        self._m27 = m27_bridge or M27Bridge(self._dense)
        self._lock = threading.Lock()
        self._infer_lock = threading.Lock()
        self._sessions: OrderedDict[str, _RealtimeSessionState] = OrderedDict()
        self._spk_cache: OrderedDict[str, np.ndarray] = OrderedDict()
        self._default_spk: Optional[np.ndarray] = None
        self._neutral_anim_cache: Optional[Dict[str, Any]] = None
        self._tract3d_topology_cache: Optional[List[Dict[str, Any]]] = None

    def _get_default_speaker(self) -> np.ndarray:
        with self._lock:
            vec = self._default_spk
        if vec is None:
            vec = load_speaker_profile_embedding(DEFAULT_TIMBRE_PROFILE)
            with self._lock:
                self._default_spk = vec
        return vec

    def _get_session(self, session_id: str) -> _RealtimeSessionState:
        now = time.monotonic()
        with self._lock:
            # Prune stale sessions (> 10 min idle)
            stale = [k for k, v in self._sessions.items() if now - v.updated_at > 600.0]
            for k in stale:
                self._sessions.pop(k, None)
            st = self._sessions.get(session_id)
            if st is None:
                st = _RealtimeSessionState()
                self._sessions[session_id] = st
            else:
                self._sessions.move_to_end(session_id)
                st.updated_at = now
            while len(self._sessions) > 16:
                self._sessions.popitem(last=False)
            return st

    def _get_cached_speaker(self, key: str) -> Optional[np.ndarray]:
        with self._lock:
            vec = self._spk_cache.get(key)
            if vec is not None:
                self._spk_cache.move_to_end(key)
            return vec

    def _put_cached_speaker(self, key: str, vec: np.ndarray) -> None:
        with self._lock:
            self._spk_cache[key] = np.ascontiguousarray(vec, dtype=np.float32)
            self._spk_cache.move_to_end(key)
            while len(self._spk_cache) > 24:
                self._spk_cache.popitem(last=False)

    def prepare_speaker(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Pre-extract and cache a 512-dim speaker embedding once before starting realtime synthesis."""
        if not isinstance(payload, dict):
            return {"ok": False, "error": {"code": "validation_error", "hint": "请求体须为 JSON 对象"}}
        wav_b64 = payload.get("speaker_wav_base64") or payload.get("speaker_ref_wav_base64")
        if not isinstance(wav_b64, str) or not wav_b64.strip():
            return {"ok": False, "error": {"code": "validation_error", "hint": "缺少参考音色音频 speaker_wav_base64"}}

        ver = LOCAL_MODEL_MANAGER.model_version_key("Vox2Spk-Lite")
        key = hashlib.blake2b(f"{ver}|{wav_b64.strip()}".encode("utf-8"), digest_size=12).hexdigest()
        if self._get_cached_speaker(key) is not None:
            return {"ok": True, "speaker_key": key, "cached": True, "extract_ms": 0.0}

        t0 = time.perf_counter()
        try:
            wav_16k = _decode_speaker_audio(wav_b64, field="speaker_wav_base64")
        except M27InputError as exc:
            return {"ok": False, "error": exc.detail}
        if len(wav_16k) < 4 * HOP_16K:
            return {"ok": False, "error": {"code": "audio_too_short", "hint": "参考音色录音至少需要 80 毫秒"}}
        max_len = 10 * SAMPLE_RATE_16K
        start = max(0, (len(wav_16k) - max_len) // 2)
        clip = np.ascontiguousarray(wav_16k[start : start + max_len], dtype=np.float32)
        try:
            emb, _ = extract_speaker_embedding(clip, device="cpu")
        except ModelUnloadedError as exc:
            return {"ok": False, "error": {"code": exc.code, "model": exc.model_name, "hint": exc.hint}}
        self._put_cached_speaker(key, emb)
        return {
            "ok": True,
            "speaker_key": key,
            "cached": False,
            "extract_ms": round((time.perf_counter() - t0) * 1000.0, 1),
        }

    def _extract_anim_fast(self, m27_50hz_dpa: np.ndarray, *, fps: int = 25) -> Dict[str, Any]:
        ensure_pure_numpy_imports()
        from tt3.tract_anim import extract_m27_animation

        with self._dense.lease("JD2") as eng:
            anim = extract_m27_animation(eng, m27_50hz_dpa, fps=fps, apply_qta=False)
        for frame in anim["frames"]:
            frame["pr_pa"] = round(frame.pop("pr") / 10.0, 1)
        return anim

    def _extract_tract_3d_fast(self, m27_row_dpa: np.ndarray, *, include_topology: bool = False) -> Dict[str, Any]:
        """Extract compact 3D VTL organ vertices (~1 ms, ~27 KB base64) without 65-section or FFT overhead."""
        p19 = _m27_to_tract19(np.asarray(m27_row_dpa, dtype=np.float64).reshape(-1))
        i_ptr_t = C.POINTER(C.c_int)
        with self._lock:
            cached_topo = self._tract3d_topology_cache
        need_topo = include_topology or cached_topo is None
        topo_built: Optional[List[Dict[str, Any]]] = [] if need_topo else None

        with self._dense.lease("JD2") as eng:
            p_val = eng.validated(p19)
            with eng.geometry_lock:
                eng.geom.p8_tongue_shape(0.0, 0.0)
                eng.geom.p10_lip_shape(0.0, 0.0, 0.0, 0.0)
                eng.geom.p4_larynx(0.0)
                limited = np.zeros(eng.ntract, dtype=np.float64)
                eng.geom.p2_update(dp(p_val), 1.0, dp(limited))
                vert_chunks: List[np.ndarray] = []
                for idx, (nv, nf, nr, np_) in enumerate(eng.meshmeta):
                    v = np.empty((nv, 3), dtype=np.float64)
                    f = np.empty((nf, 3), dtype=np.int32)
                    counts = np.zeros(4, dtype=np.int32)
                    eng.geom.p0_mesh(idx, dp(v), f.ctypes.data_as(i_ptr_t), counts.ctypes.data_as(i_ptr_t))
                    vert_chunks.append(np.ascontiguousarray(v, dtype="<f4").ravel())
                    if topo_built is not None:
                        tri_u16 = np.ascontiguousarray(f.ravel(), dtype="<u2")
                        topo_built.append(
                            {
                                "name": PARTS[idx],
                                "nv": int(nv),
                                "ribs": int(nr),
                                "points": int(np_),
                                "triangles_u16_b64": base64.b64encode(tri_u16.tobytes()).decode("ascii"),
                            }
                        )
                contours = eng._current_contours()
                _, _, nasal_port = eng._current_nasal()
                floor_rib = int(eng.geom.p6_floor_rib())
            names = eng.names

        if topo_built is not None:
            with self._lock:
                self._tract3d_topology_cache = topo_built
            cached_topo = topo_built

        packed_verts = np.concatenate(vert_chunks)
        out: Dict[str, Any] = {
            "vertices_f32_b64": base64.b64encode(packed_verts.tobytes()).decode("ascii"),
            "limited": np.round(limited, 5).tolist(),
            "tongue_floor_rib": floor_rib,
            "contours": {
                "upper_cover": contours["upper_cover"],
                "lower_cover": contours["lower_cover"],
                "upper_lip": contours["upper_lip"],
                "lower_lip": contours["lower_lip"],
                "upper_teeth": contours["upper_teeth"],
                "lower_teeth": contours["lower_teeth"],
                "tongue": contours["tongue"],
                "uvula": contours["uvula"],
                "epiglottis": contours["epiglottis"],
            },
            "nasal_port_area": round(float(nasal_port[1]), 5),
            "ja_deg": round(float(limited[names.index("JA")]), 4),
            "jx_cm": round(float(limited[names.index("JX")]), 4),
            "ld_cm": round(float(limited[names.index("LD")]), 4),
            "lp_cm": round(float(limited[names.index("LP")]), 4),
            "vo": round(float(limited[names.index("VO")]), 4),
            "tcy_cm": round(float(limited[names.index("TCY")]), 4),
            "tty_cm": round(float(limited[names.index("TTY")]), 4),
        }
        if include_topology and cached_topo is not None:
            out["topology"] = cached_topo
        return out

    def _get_neutral_anim(self, n_frames: int, fps: int = 25) -> Dict[str, Any]:
        with self._lock:
            base = self._neutral_anim_cache
        if base is None:
            base = self._extract_anim_fast(REST_M27_PHYS[None, :], fps=50)
            with self._lock:
                self._neutral_anim_cache = base
        stride = max(1, int(round(50.0 / max(5, min(50, int(fps))))))
        base_f = base["frames"][0]
        frames = []
        for idx in range(0, max(1, n_frames), stride):
            f_copy = dict(base_f)
            f_copy["t"] = round(idx * 0.02, 3)
            frames.append(f_copy)
        return {
            **base,
            "fps": round(50.0 / stride, 2),
            "duration_sec": round(n_frames * 0.02, 3),
            "frame_count": len(frames),
            "frames": frames,
        }

    def _resolve_live_speaker(
        self,
        *,
        use_timbre_model: bool,
        speaker_key: str,
        speaker_wav_b64: str,
        speaker_mode: str,
        session: _RealtimeSessionState,
        active_speech_16k: Optional[np.ndarray],
    ) -> Tuple[np.ndarray, str]:
        """Resolve a 512-dim speaker vector without per-frame Vox2Spk-Lite overhead."""
        if not use_timbre_model:
            return self._get_default_speaker(), "builtin-default"

        if speaker_key:
            cached = self._get_cached_speaker(speaker_key)
            if cached is not None:
                return cached, "reference-cached"

        if speaker_wav_b64:
            prep = self.prepare_speaker({"speaker_wav_base64": speaker_wav_b64})
            if prep.get("ok") and prep.get("speaker_key"):
                cached = self._get_cached_speaker(str(prep["speaker_key"]))
                if cached is not None:
                    return cached, "reference-cached"

        if speaker_mode == "lecture":
            return self._get_default_speaker(), "lecture-default"

        # speaker_mode == "input": auto-lock speaker's own voice once >= 0.8s active speech collected
        if session.self_spk_emb is not None:
            return session.self_spk_emb, "live-input-locked"

        if active_speech_16k is not None and len(active_speech_16k) >= HOP_16K:
            session.self_speech_buf.append(np.ascontiguousarray(active_speech_16k, dtype=np.float32))
            total_len = sum(len(x) for x in session.self_speech_buf)
            if total_len >= int(0.8 * SAMPLE_RATE_16K) and LOCAL_MODEL_MANAGER.is_enabled("Vox2Spk-Lite"):
                joined = np.concatenate(session.self_speech_buf)[-SAMPLE_RATE_16K * 2 :]
                emb, _ = extract_speaker_embedding(joined, device="cpu")
                session.self_spk_emb = emb
                session.self_speech_buf.clear()
                return emb, "live-input-locked"

        return self._get_default_speaker(), "warming-input"

    def step(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Run one low-latency realtime sliding-window step."""
        t0 = time.perf_counter()
        if not isinstance(payload, dict):
            return {"ok": False, "error": {"code": "validation_error", "hint": "请求体须为 JSON 对象"}}

        warmup = payload.get("warmup") is True
        synthesize_audio = bool(payload.get("synthesize_audio", False))
        if warmup:
            warmup_frames = payload.get("warmup_window_frames", 85 if synthesize_audio else 35)
            max_window_frames = MAX_LIVE_WINDOW_SAMPLES // HOP_16K
            if type(warmup_frames) is not int or not 12 <= warmup_frames <= max_window_frames:
                return {"ok": False, "error": {
                    "code": "out_of_range",
                    "hint": f"warmup_window_frames 须为 12–{max_window_frames} 之间的整数",
                }}
            t = np.arange(warmup_frames * HOP_16K, dtype=np.float32) / SAMPLE_RATE_16K
            wav_16k = 0.12 * np.sin(2.0 * np.pi * 160.0 * t)
        else:
            pcm_b64 = payload.get("pcm16le_base64")
            if not isinstance(pcm_b64, str) or not pcm_b64.strip():
                return {"ok": False, "error": {"code": "validation_error", "hint": "缺少 16 kHz PCM 音频窗 pcm16le_base64"}}
            try:
                raw = base64.b64decode(pcm_b64, validate=True)
            except Exception:
                return {"ok": False, "error": {"code": "validation_error", "hint": "pcm16le_base64 解码失败"}}
            if len(raw) < 4 * HOP_16K * 2 or len(raw) > MAX_LIVE_WINDOW_SAMPLES * 2 or len(raw) % 2:
                return {"ok": False, "error": {"code": "validation_error", "hint": "实时音频窗长度须为 80 ms–2.0 s 的 16 kHz 16-bit PCM"}}
            wav_16k = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
        n_frames = len(wav_16k) // HOP_16K
        wav_16k = np.ascontiguousarray(wav_16k[: n_frames * HOP_16K], dtype=np.float32)

        emit_frames = int(payload.get("emit_frames", 5))
        lookahead_frames = int(payload.get("lookahead_frames", 3))
        if not 1 <= emit_frames <= 30:
            return {"ok": False, "error": {"code": "out_of_range", "hint": "emit_frames 须在 1–30 之间"}}
        if not 0 <= lookahead_frames <= MAX_LOOKAHEAD_FRAMES:
            return {"ok": False, "error": {"code": "out_of_range", "hint": f"lookahead_frames 须在 0–{MAX_LOOKAHEAD_FRAMES} 之间"}}

        include_tract_geometry = bool(payload.get("include_tract_geometry", True))
        include_tract_3d = bool(payload.get("include_tract_3d", False))
        include_tract_3d_topology = bool(payload.get("include_tract_3d_topology", False))
        use_timbre_model = bool(payload.get("use_timbre_model", True))
        fps = max(10, min(50, int(payload.get("fps", 25))))
        session_id = str(payload.get("session_id") or "default")[:64]
        speaker_key = str(payload.get("speaker_key") or "").strip()
        speaker_wav_b64 = str(payload.get("speaker_wav_base64") or "").strip()
        speaker_mode = str(payload.get("speaker_mode") or "input").strip()
        if not warmup and payload.get("reset_session") is True:
            with self._lock:
                self._sessions.pop(session_id, None)

        eff_lookahead = min(lookahead_frames, max(0, n_frames - 1))
        emit_b = max(1, n_frames - eff_lookahead)
        emit_a = max(0, emit_b - emit_frames)
        n_emit = emit_b - emit_a

        session = _RealtimeSessionState() if warmup else self._get_session(session_id)

        # Frame-level RMS energy for fast silence detection & smooth resting relaxation
        frame_wav = wav_16k.reshape(n_frames, HOP_16K)
        frame_rms = np.sqrt(np.mean(frame_wav * frame_wav, axis=1) + 1e-12).astype(np.float32)
        emit_rms_peak = float(np.max(frame_rms[max(0, emit_a - 2) : min(n_frames, emit_b + 2)]))
        window_rms_peak = float(np.max(frame_rms))

        # Fast-path silence bypass: < 1 ms CPU, zero tongue twitching, zero hallucinated breath noise
        if window_rms_peak < SILENCE_RMS_THRESHOLD or emit_rms_peak < SILENCE_RMS_THRESHOLD:
            # Smoothly relax from previous frame back to resting pose
            prev = session.last_m27_dpa.copy()
            emitted_dpa = np.empty((n_emit, 27), dtype=np.float32)
            for k in range(n_emit):
                alpha_relax = 0.45
                prev = (1.0 - alpha_relax) * prev + alpha_relax * REST_M27_PHYS
                prev[18] = 0.0
                prev[23] = 0.0
                emitted_dpa[k] = prev
            session.last_m27_dpa = emitted_dpa[-1].copy()

            emitted_pa = emitted_dpa.copy()
            emitted_pa[:, 18] /= 10.0
            out: Dict[str, Any] = {
                "ok": True,
                "silent": True,
                "emit_frames": n_emit,
                "m27_50hz_pa": np.round(emitted_pa, 4).tolist(),
                "f0_hz": round(float(emitted_pa[-1, 17]), 1),
                "pr_pa": 0.0,
                "voiced": False,
                "timbre_status": "idle",
                "compute_ms": round((time.perf_counter() - t0) * 1000.0, 1),
            }
            if include_tract_geometry:
                out["tract_glottis_anim"] = self._get_neutral_anim(n_emit, fps=fps)
            if include_tract_3d:
                out["tract_3d"] = self._extract_tract_3d_fast(
                    emitted_dpa[-1],
                    include_topology=include_tract_3d_topology,
                )
            if synthesize_audio:
                # A zero-valued overlap fades the preceding voiced block into
                # silence on the same sample clock as voiced-to-voiced blocks.
                overlap_l = LIVE_AUDIO_OVERLAP_16K if session.has_audio_predecessor else 0
                out["audio_sr"] = SAMPLE_RATE_16K
                out["overlap_left_samples"] = overlap_l
                out["pcm16le_base64"] = base64.b64encode(
                    np.zeros(overlap_l + n_emit * HOP_16K, dtype="<i2").tobytes()
                ).decode("ascii")
            session.has_audio_predecessor = synthesize_audio
            out["compute_ms"] = round((time.perf_counter() - t0) * 1000.0, 1)
            return out

        ensure_pure_numpy_imports()
        from kf_ipa_synth.m27_contract import denormalize_m27, normalize_f0_m27, normalize_m27

        try:
            with self._infer_lock:
                # 1. Pitch track on the 50 Hz control grid
                f0_hz, _ = extract_swift_f0_50hz(wav_16k, fmin=40.0, fmax=600.0, num_frames=n_frames)
                f0_norm = normalize_f0_m27(f0_hz)

                # 2. Vox2Tract-Lite inversion with left context and lookahead
                tr17, pr1, gl8, _, _, _ = run_vox2tract_chunk(wav_16k, f0_norm, device="cpu")
                m27_norm_full = _pack_m27_norm(tr17, f0_norm[None, :], pr1, gl8)[0]
                m27_dpa_full = denormalize_m27(m27_norm_full)

                # 3. Soft RMS speech gate to suppress mic-noise jitter on silent frames
                soft_gate = np.clip((frame_rms - SILENCE_RMS_THRESHOLD) / max(1e-4, SPEECH_RMS_FULL - SILENCE_RMS_THRESHOLD), 0.0, 1.0)
                if len(soft_gate) >= 3:
                    soft_gate = np.convolve(np.pad(soft_gate, (1, 1), mode="edge"), np.array([0.25, 0.5, 0.25], dtype=np.float32), mode="valid")
                    if synthesize_audio:
                        # Keep short low-energy transitions next to speech. Isolated
                        # quiet windows still take the silence path above.
                        padded = np.pad(soft_gate, (2, 2), mode="edge")
                        nearby = np.maximum(padded[:-4], padded[4:])
                        soft_gate = np.maximum(soft_gate, 0.65 * nearby)
                g = soft_gate[:, None]
                m27_dpa_full[:, :17] = g * m27_dpa_full[:, :17] + (1.0 - g) * REST_M27_PHYS[None, :17]
                m27_dpa_full[:, 18:] = g * m27_dpa_full[:, 18:] + (1.0 - g) * REST_M27_PHYS[None, 18:]

                # Smooth continuity across step boundary with previous emitted frame (first 2 frames only)
                emitted_dpa = m27_dpa_full[emit_a:emit_b].copy()
                prev = session.last_m27_dpa
                for k, w_prev in enumerate((0.45, 0.20)):
                    if k < len(emitted_dpa):
                        emitted_dpa[k, :17] = w_prev * prev[:17] + (1.0 - w_prev) * emitted_dpa[k, :17]
                        emitted_dpa[k, 18:] = w_prev * prev[18:] + (1.0 - w_prev) * emitted_dpa[k, 18:]
                session.last_m27_dpa = emitted_dpa[-1].copy()
                m27_dpa_full[emit_a:emit_b] = emitted_dpa

                # 4. Optional realtime neural audio synthesis via Tract2Vox-Lite
                audio_pcm_b64: Optional[str] = None
                overlap_l = 0
                timbre_status = "off"
                if synthesize_audio:
                    if warmup and use_timbre_model and speaker_mode == "input" and LOCAL_MODEL_MANAGER.is_enabled("Vox2Spk-Lite"):
                        extract_speaker_embedding(wav_16k[: int(0.8 * SAMPLE_RATE_16K)], device="cpu")
                    active_slice = wav_16k[emit_a * HOP_16K : emit_b * HOP_16K] if emit_rms_peak >= SPEECH_RMS_FULL * 0.7 else None
                    spk_vec, timbre_status = self._resolve_live_speaker(
                        use_timbre_model=use_timbre_model,
                        speaker_key=speaker_key,
                        speaker_wav_b64=speaker_wav_b64,
                        speaker_mode=speaker_mode,
                        session=session,
                        active_speech_16k=active_slice,
                    )
                    voc_sess, _ = LOCAL_MODEL_MANAGER.require_session("Tract2Vox-Lite", device="cpu")
                    ctx_l = min(VOCODER_MAX_LEFT_CONTEXT_FRAMES, VOCODER_BASE_LEFT_CONTEXT_FRAMES + eff_lookahead, emit_a)
                    ctx_r = min(VOCODER_MAX_RIGHT_CONTEXT_FRAMES, n_frames - emit_b)
                    sl_a = emit_a - ctx_l
                    sl_b = emit_b + ctx_r
                    m27_voc_norm = normalize_m27(m27_dpa_full[sl_a:sl_b])[None, :, :]
                    n_voc = sl_b - sl_a
                    spk_seq = np.repeat(spk_vec[None, None, :], n_voc, axis=1).astype(np.float32)
                    env_rand, n_wb = ofr.make_vocoder_noise(n_voc, batch_size=1, seed=20261122)
                    wav_voc = voc_sess.run(
                        ["wav_16k"],
                        {
                            "m27_norm": np.ascontiguousarray(m27_voc_norm, dtype=np.float32),
                            "spk_seq": np.ascontiguousarray(spk_seq, dtype=np.float32),
                            "env_rand": env_rand,
                            "n_wb": n_wb,
                        },
                    )[0][0]
                    base_s0 = ctx_l * HOP_16K
                    overlap_l = min(LIVE_AUDIO_OVERLAP_16K, base_s0)
                    seg_a = base_s0 - overlap_l
                    seg_b = base_s0 + n_emit * HOP_16K
                    seg = np.ascontiguousarray(wav_voc[seg_a:seg_b], dtype=np.float64)
                    # Interpolate frame-centered pressure to avoid amplitude steps at 50 Hz.
                    pr_frame_env = np.clip((m27_dpa_full[sl_a:sl_b, 18] - 20.0) / 180.0, 0.0, 1.0)
                    pr_samp = np.interp(
                        np.arange(seg_a, seg_b),
                        (np.arange(n_voc) + 0.5) * HOP_16K,
                        pr_frame_env,
                    )
                    seg = _soft_limit_audio(seg * pr_samp, knee=0.82, ceiling=0.95)
                    pcm16 = np.clip(np.round(seg * 32767.0), -32768, 32767).astype("<i2")
                    audio_pcm_b64 = base64.b64encode(pcm16.tobytes()).decode("ascii")
        except ModelUnloadedError as exc:
            return {"ok": False, "error": {"code": exc.code, "model": exc.model_name, "hint": exc.hint}}

        emitted_pa = emitted_dpa.copy()
        emitted_pa[:, 18] /= 10.0
        last_row = emitted_pa[-1]
        out = {
            "ok": True,
            "silent": False,
            "emit_frames": n_emit,
            "m27_50hz_pa": np.round(emitted_pa, 4).tolist(),
            "f0_hz": round(float(last_row[17]), 1),
            "pr_pa": round(float(last_row[18]), 1),
            "voiced": bool(last_row[18] > 150.0 and last_row[23] > 0.12),
            "timbre_status": timbre_status,
        }
        if include_tract_geometry:
            out["tract_glottis_anim"] = self._extract_anim_fast(emitted_dpa, fps=fps)
        if include_tract_3d:
            out["tract_3d"] = self._extract_tract_3d_fast(
                emitted_dpa[-1],
                include_topology=include_tract_3d_topology,
            )
        if audio_pcm_b64 is not None:
            out["audio_sr"] = SAMPLE_RATE_16K
            out["overlap_left_samples"] = int(overlap_l)
            out["pcm16le_base64"] = audio_pcm_b64
        session.has_audio_predecessor = audio_pcm_b64 is not None
        out["compute_ms"] = round((time.perf_counter() - t0) * 1000.0, 1)
        if warmup:
            return {"ok": True, "compute_ms": out["compute_ms"]}
        return out
