"""Render steady JD2 vowels with a checked physical carrier and TD-PSOLA."""
from __future__ import annotations

import base64
from dataclasses import dataclass
from io import BytesIO
import math
import wave

import numpy as np
from scipy.interpolate import CubicSpline
from scipy.signal import correlate

from dense_channel import F0_MAX_HZ, DenseEngineManager, apply_synthesis_gain, pcm_float_to_wav_bytes
from phonetic_core.vocal_tract.vowel_defaults import vowel_defaults
from validation import SAMPLE_RATE_HZ, validate_scalar_range, validation_error


MIN_TARGET_HZ = 550
MAX_TARGET_HZ = 800
MIN_DURATION_MS = 300
MAX_DURATION_MS = 3000
VOWELS = ("a", "i", "u")
STEP_HZ = 200
PRESSURE_PA = 800
# Let the native source settle, and keep real samples outside the preview for overlap-add.
PAD_SMP = SAMPLE_RATE_HZ // 10


@dataclass(frozen=True)
class PitchCheck:
    f0_hz: float
    correlation_p10: float
    f0_error_p90_hz: float
    rms_p10: float
    odd_harmonic_fraction: float

    def stable(self, expected_hz: float) -> bool:
        return (
            self.rms_p10 >= 1e-4
            and self.correlation_p10 >= 0.95
            and self.f0_error_p90_hz <= expected_hz * 0.015
            and self.odd_harmonic_fraction >= 0.005
        )


def _peak_offset(left: float, center: float, right: float) -> float:
    curvature = left - 2 * center + right
    if center < max(left, right) or curvature >= -1e-12:
        return 0.0
    return float(0.5 * (left - right) / curvature)


def _lag_correlations(reference: np.ndarray, delayed: np.ndarray) -> np.ndarray:
    delayed -= delayed.mean(axis=-1, keepdims=True)
    return np.einsum("j,ij->i", reference, delayed) / np.maximum(
        np.linalg.norm(reference) * np.linalg.norm(delayed, axis=-1), 1e-12,
    )


def _pitch_check(audio: np.ndarray, expected_hz: float) -> PitchCheck:
    """Measure overlapping 40 ms windows with a bounded lag search at the intended pitch."""
    period = SAMPLE_RATE_HZ / expected_hz
    lags = np.arange(math.floor(period * 0.86), math.ceil(period * 1.14) + 1)
    block_size = round(SAMPLE_RATE_HZ * 0.04)
    positions = np.arange(block_size - lags[-1])
    interpolate = CubicSpline(np.arange(len(audio)), audio)
    fractional_step = 0.125
    fractional_offsets = np.arange(-6, 7) * fractional_step
    measured_periods, peaks, rms = [], [], []
    for start in range(0, len(audio) - block_size + 1, block_size // 2):
        block = audio[start:start + block_size]
        reference = block[positions]
        reference -= reference.mean()
        coarse = _lag_correlations(reference, block[lags[:, None] + positions])
        best_lag = lags[1 + int(np.argmax(coarse[1:-1]))]
        fine_lags = best_lag + fractional_offsets
        fine = _lag_correlations(reference, interpolate(start + fine_lags[:, None] + positions))
        index = 1 + int(np.argmax(fine[1:-1]))
        offset = _peak_offset(fine[index - 1], fine[index], fine[index + 1])
        measured_periods.append(fine_lags[index] + offset * fractional_step)
        peaks.append(fine[index])
        rms.append(np.std(block))
    f0 = SAMPLE_RATE_HZ / np.asarray(measured_periods)
    measured_f0 = float(np.median(f0))

    # A lag at the expected period would also match its exact octave. Check
    # that the signal contains odd harmonics of the intended fundamental.
    segment = audio[len(audio) // 4:3 * len(audio) // 4]
    spectrum = np.abs(np.fft.rfft((segment - segment.mean()) * np.hanning(len(segment)))) ** 2
    harmonic_index = np.arange(len(spectrum)) * SAMPLE_RATE_HZ / (len(segment) * measured_f0)
    odd = (np.rint(harmonic_index) % 2 == 1) & (np.abs(harmonic_index - np.rint(harmonic_index)) < 0.08)
    return PitchCheck(
        measured_f0, float(np.quantile(peaks, 0.1)), float(np.quantile(np.abs(f0 - expected_hz), 0.9)),
        float(np.quantile(rms, 0.1)), float(spectrum[odd].sum() / max(spectrum.sum(), 1e-12)),
    )


def _cycle_marks(source: np.ndarray, center: int, period: float) -> np.ndarray:
    """Find corresponding waveform epochs in consecutive steady source cycles."""
    half_width = round(period)
    start = center - half_width
    anchor = start + 1 + int(np.argmax(np.abs(np.diff(source[start:center + half_width + 1]))))
    template = source[anchor - half_width:anchor + half_width + 1].copy()
    template -= template.mean()
    dot_product = correlate(source, template, mode="valid", method="fft")
    sums = np.r_[0.0, np.cumsum(source)]
    sums_squared = np.r_[0.0, np.cumsum(source ** 2)]
    window_len = len(template)
    energy = (sums_squared[window_len:] - sums_squared[:-window_len]
              - (sums[window_len:] - sums[:-window_len]) ** 2 / window_len)
    similarity = dot_product / np.maximum(np.linalg.norm(template) * np.sqrt(np.maximum(energy, 0)), 1e-12)

    def follow(direction: int) -> list[float]:
        marks = []
        current = float(anchor - half_width)
        radius = round(0.16 * period)
        while radius + 1 <= (predicted := round(current + direction * period)) < len(similarity) - radius - 1:
            start = predicted - radius
            best = start + int(np.argmax(similarity[start:predicted + radius + 1]))
            left, peak, right = similarity[best - 1:best + 2]
            current = best + _peak_offset(left, peak, right)
            marks.append(current + half_width)
        return marks

    return np.array([*reversed(follow(-1)), float(anchor), *follow(1)])


def _td_psola(source: np.ndarray, source_hz: float, target_hz: float, sample_count: int) -> np.ndarray | None:
    """Move Hann-windowed grains to a new excitation grid without stretching them."""
    period = SAMPLE_RATE_HZ / source_hz
    target_period = SAMPLE_RATE_HZ / target_hz
    marks = _cycle_marks(source, PAD_SMP + sample_count // 2, period)
    centers = np.arange(-math.ceil(period / target_period), math.ceil((sample_count + period) / target_period)) * target_period
    source_centers = centers + PAD_SMP
    if (len(marks) < 2 or not np.all(np.diff(marks) > 0)
            or marks[0] >= source_centers[0] or marks[-1] < source_centers[-1]):
        return None
    right = np.searchsorted(marks, source_centers)
    left = right - 1
    closest = np.where(source_centers - marks[left] <= marks[right] - source_centers, left, right)
    interpolate = CubicSpline(np.arange(len(source)), source, extrapolate=False)
    audio = np.zeros(sample_count)
    weights = np.zeros(sample_count)
    for center, mark in zip(centers, marks[closest]):
        start = max(0, math.ceil(center - period))
        stop = min(sample_count, math.floor(center + period) + 1)
        if start >= stop:
            continue
        offsets = np.arange(start, stop) - center
        window = 0.5 + 0.5 * np.cos(np.pi * offsets / period)
        audio[start:stop] += window * interpolate(mark + offsets)
        weights[start:stop] += window
    if not np.all(weights > 0) or not np.isfinite(audio).all():
        return None
    return audio / weights


def _preview_wav(audio: np.ndarray, audio_gain: str | None = "peak") -> str:
    audio = audio - audio.mean()
    fade = round(SAMPLE_RATE_HZ * 0.015)
    ramp = np.sin(np.linspace(0, np.pi / 2, fade)) ** 2
    audio[:fade] *= ramp
    audio[-fade:] *= ramp[::-1]
    audio = apply_synthesis_gain(audio, audio_gain)
    return base64.b64encode(pcm_float_to_wav_bytes(audio)).decode("ascii")


def _decode_physical_wav(encoded: str) -> np.ndarray:
    with wave.open(BytesIO(base64.b64decode(encoded)), "rb") as audio:
        return np.frombuffer(audio.readframes(audio.getnframes()), dtype="<i2").astype(np.float64) / 32768.0


def render_high_pitch_preview(payload: dict, dense_manager: DenseEngineManager) -> dict:
    if not isinstance(payload, dict):
        return validation_error("body", "高音试听参数须为 JSON 对象")
    target_hz = payload.get("target_f0_hz")
    duration_ms = payload.get("duration_ms")
    error = (
        validate_scalar_range("target_f0_hz", target_hz, MIN_TARGET_HZ, MAX_TARGET_HZ, "Hz", tol=0)
        or validate_scalar_range("duration_ms", duration_ms, MIN_DURATION_MS, MAX_DURATION_MS, "ms", tol=0)
    )
    if error:
        return error
    if type(duration_ms) is not int:
        return validation_error("duration_ms", "试听时长须为整数毫秒")
    vowel = payload.get("vowel")
    if vowel not in VOWELS:
        return validation_error("vowel", "高音试听可选择 JD2 的 [a]、[i] 或 [u]")
    audio_gain = payload.get("audio_gain", "peak")
    if audio_gain not in ("peak", "original"):
        return validation_error("audio_gain", "音量模式应为自动增益或原始电平")
    target_hz = float(target_hz)
    with dense_manager.lease("JD2") as engine:
        preset = {vowel: {"params": engine.preset(vowel).tolist()}}
        pose = vowel_defaults(engine, preset)[vowel]["params"]
        ceiling_hz = min(target_hz, F0_MAX_HZ, float(engine.gmax[0]))

    sample_count = duration_ms * (SAMPLE_RATE_HZ // 1000)
    source_count = sample_count + 2 * PAD_SMP
    frames = math.ceil(source_count / (SAMPLE_RATE_HZ // STEP_HZ))
    candidates = (ceiling_hz, *(hz for hz in range(590, MIN_TARGET_HZ - 1, -10) if hz < ceiling_hz))
    core = slice(PAD_SMP, PAD_SMP + sample_count)
    check_core = slice(round(SAMPLE_RATE_HZ * 0.02), sample_count - round(SAMPLE_RATE_HZ * 0.02))
    carrier_found = False
    for command_hz in candidates:
        if command_hz < MIN_TARGET_HZ:
            break
        rendered = dense_manager.synthesize_dense({
            "speaker": "JD2", "step_hz": STEP_HZ, "sample_count": source_count,
            "f0_hz": [command_hz] * frames, "pressure_pa": [PRESSURE_PA] * frames,
            "tract_frames": [pose] * frames, "flutter": 0.0, "include_geometry": False,
            "audio_gain": "original",
        })
        if not rendered.get("ok"):
            return rendered
        source = _decode_physical_wav(rendered["wav_base64"])
        carrier = _pitch_check(source[core][check_core], command_hz)
        if not carrier.stable(command_hz):
            continue
        carrier_found = True
        shifted = command_hz < target_hz
        audio = _td_psola(source, carrier.f0_hz, target_hz, sample_count) if shifted else source[core]
        if audio is None:
            continue
        output = _pitch_check(audio[check_core], target_hz) if shifted else carrier
        if not output.stable(target_hz):
            continue
        return {
            "ok": True, "speaker": "JD2", "vowel": vowel, "method": "td-psola" if shifted else "vtl",
            "sample_rate_hz": SAMPLE_RATE_HZ, "sample_count": sample_count, "target_f0_hz": target_hz,
            "carrier_command_hz": command_hz, "carrier_measured_hz": round(carrier.f0_hz, 3),
            "carrier_periodicity": round(carrier.correlation_p10, 5),
            "output_measured_hz": round(output.f0_hz, 3), "output_periodicity": round(output.correlation_p10, 5),
            "wav_base64": _preview_wav(audio, audio_gain),
            **({"carrier_wav_base64": _preview_wav(source[core], audio_gain)} if shifted else {}),
        }
    if carrier_found:
        return validation_error("target_f0_hz", "移调结果的基频或周期性未通过检查，请降低目标基频")
    return validation_error("vowel", "没有找到通过检查的物理载波，请更换元音或在 550–600 Hz 内调整目标基频")
