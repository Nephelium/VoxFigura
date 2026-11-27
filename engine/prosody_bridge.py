"""Zero-PyTorch ONNX Runtime bridge for Mandarin/English Text2Prosody-Lite."""
from __future__ import annotations

import math
from threading import Lock
from typing import Any, Dict

from onnx_inference import ensure_pure_numpy_imports, predict_prosody_timeline_onnx


class _OnnxProsodyPredictor:
    def predict_timeline(self, text: str, **kwargs: Any) -> Dict[str, Any]:
        return predict_prosody_timeline_onnx(text, **kwargs)


class ProsodyBridge:
    def __init__(self) -> None:
        self._lock = Lock()
        self._predictor = _OnnxProsodyPredictor()

    def _get_predictor(self) -> Any:
        return self._predictor

    def predict(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        text = payload.get("text")
        if not isinstance(text, str) or not text.strip() or len(text) > 600:
            raise ValueError("韵律预测支持 1–600 字符的中英文文本")

        lang = str(payload.get("lang") or "auto")
        if lang not in ("auto", "zh", "en"):
            raise ValueError("Text2Prosody-Lite 语言支持 auto / zh / en")

        def _num_opt(name: str, default: float, lo: float, hi: float) -> float:
            raw = payload.get(name, default)
            if isinstance(raw, bool) or not isinstance(raw, (int, float)):
                raise ValueError(f"{name} 须为有限数值")
            try:
                val = float(raw)
            except OverflowError as exc:
                raise ValueError(f"{name} 数值溢出，超出允许范围 [{lo}, {hi}]") from exc
            if not math.isfinite(val):
                raise ValueError(f"{name} 须为有限数值")
            if val < lo or val > hi:
                raise ValueError(f"{name} ({val}) 超出允许范围 [{lo}, {hi}]")
            return val

        def _pos_opt(name: str, default: float) -> float:
            raw = payload.get(name, default)
            if isinstance(raw, bool) or not isinstance(raw, (int, float)):
                raise ValueError(f"{name} 须为有限正数")
            try:
                val = float(raw)
            except OverflowError as exc:
                raise ValueError(f"{name} 数值溢出，须为有限正数 (> 0)") from exc
            if not math.isfinite(val) or val <= 0.0:
                raise ValueError(f"{name} ({val}) 须为有限正数 (> 0)")
            return val

        base_f0 = _pos_opt("base_f0", 165.0)
        speed_scale = _num_opt("speed_scale", 1.0, 0.5, 2.0)
        pitch_scale = _num_opt("pitch_scale", 1.35, 0.5, 2.5)
        raw_floor = payload.get("f0_min_hz")
        f0_min_hz = _pos_opt("f0_min_hz", 0.0) if raw_floor is not None else None
        tone_sandhi = payload.get("tone_sandhi", True)
        if type(tone_sandhi) is not bool:
            raise ValueError("tone_sandhi 须为布尔值")

        with self._lock:
            result = self._get_predictor().predict_timeline(
                text,
                lang=lang,
                base_f0=base_f0,
                speed_scale=speed_scale,
                pitch_scale=pitch_scale,
                tone_sandhi=tone_sandhi,
            )
            if not result.get("ok") or not result.get("keyframes_neural"):
                raise ValueError("韵律模型没有返回可用的音段")

            syllables = result.get("syllables")
            if syllables is None:
                ensure_pure_numpy_imports()
                from kf_ipa_synth.text2ipa import convert_text_to_timeline
                syllables = convert_text_to_timeline(
                    text, lang=lang, bpm=108.0, base_f0=base_f0, tone_sandhi=tone_sandhi,
                )["syllables"]

        adjusted_count = 0
        knots = []
        for pt in result["f0_knots_neural"]:
            hz = float(pt["hz"])
            if f0_min_hz is not None and hz < f0_min_hz:
                hz = round(f0_min_hz, 1)
                adjusted_count += 1
            knots.append({"t": pt["t"], "hz": hz})

        keyframes = []
        for kf in result["keyframes_neural"]:
            item = dict(kf)
            if f0_min_hz is not None and isinstance(item.get("f0_hz"), (int, float)) and float(item["f0_hz"]) < f0_min_hz:
                item["f0_hz"] = round(f0_min_hz, 1)
            keyframes.append(item)

        return {
            "ok": True,
            "model": result["model_meta"]["file"],
            "f0_floor_hz": f0_min_hz,
            "f0_adjusted_count": adjusted_count,
            "syllables": [
                {"id": syl["id"], "text": syl["text"], "tone": syl["tone"], "candidates": syl["candidates"]}
                for syl in syllables
            ],
            "keyframes": keyframes,
            "f0_knots": knots,
        }
