"""CPU neural inference on arrays. Sessions and weights are supplied by adapters.

SwiftF0 0.3.0 framing/gating follows Lars Nieradzik's MIT implementation.
DPDFNet STFT, state initialization and 4-hop compensation follow Ceva's
Apache-2.0 inference package 0.6.0, using NumPy FFT and scipy resampling.
"""
from dataclasses import dataclass
from math import gcd

import numpy as np
from scipy.signal import resample_poly


@dataclass(frozen=True)
class NeuralPitch:
    times: np.ndarray
    values: np.ndarray
    confidence: np.ndarray
    actual_backend: str = 'swift-f0/0.3.0'


def resample(audio, source, target):
    if source == target:
        return np.asarray(audio, dtype=np.float32).copy()
    common = gcd(int(source), int(target))
    return resample_poly(audio, target // common, source // common).astype(np.float32)


def swift_pitch(audio, rate, session, low=46.875, high=2093.75, *, check=lambda: None):
    low, high = max(46.875, low), min(2093.75, high)
    if not low < high or high < low * (2093.75 / 46.875) ** (1 / 94):
        raise ValueError('SwiftF0 搜索范围需在 46.875–2093.75 Hz 内且包含一个模型频率格')
    x = np.asarray(audio, dtype=np.float32)
    if x.ndim != 1 or not np.isfinite(x).all():
        raise ValueError('SwiftF0 需要有限单声道波形')
    if not len(x):
        return NeuralPitch(np.array([]), np.array([]), np.array([]))
    x = resample(x, rate, 16000)
    count = max(1, len(x) // 256)
    pitches, scores = [], []
    for first in range(0, count, 1875):
        check()
        last = min(count, first + 1875)
        left = max(0, first - 11)
        part = x[left * 256:(last + 10) * 256] if last < count else x[left * 256:]
        pitch, confidence = session.run(['pitch', 'confidence'], dict(audio=part[None],
            fmin=np.asarray(low, np.float32), fmax=np.asarray(high, np.float32)))
        pitches.append(pitch[0, first-left:last-left])
        scores.append(confidence[0, first-left:last-left])
    pitch = np.concatenate(pitches).astype(float)
    confidence = np.concatenate(scores).astype(float)
    hops = x[:count * 256].reshape(count, 256) if len(x) >= 256 else x[None]
    confidence[np.abs(hops).max(axis=1) < .001] = 0
    values = np.where((confidence >= .5) & (pitch >= low) & (pitch <= high), pitch, np.nan)
    return NeuralPitch(np.arange(count) * .016, values, confidence)


def dpdfnet(audio, rate, session, *, check=lambda: None, progress=lambda value: None):
    """Offline full-file inference, preserving state and input sample count."""
    x = np.asarray(audio, dtype=np.float32)
    if x.ndim != 1 or not len(x) or not np.isfinite(x).all():
        raise ValueError('DPDFNet 需要非空、有限单声道波形')
    signal = resample(x, rate, 48000)
    metadata = session.get_modelmeta().custom_metadata_map
    state = np.zeros(int(metadata['state_size']), np.float32)
    erb = np.fromstring(metadata['erb_norm_init'], sep=',', dtype=np.float32)
    spec = np.fromstring(metadata['spec_norm_init'], sep=',', dtype=np.float32)
    state[:len(erb)] = erb
    state[len(erb):len(erb)+len(spec)] = spec
    window_size, hop = 960, 480
    i = np.arange(window_size)
    window = np.sin(.5 * np.pi * np.sin(np.pi * (i + .5) / window_size) ** 2).astype(np.float32)
    padded = np.pad(signal, (0, window_size))
    padded = np.pad(padded, (hop, hop), mode='reflect')
    count = 1 + (len(padded) - window_size) // hop
    output = np.zeros((count-1)*hop+window_size, np.float64)
    normalization = np.zeros_like(output)
    inputs, outputs = session.get_inputs(), session.get_outputs()
    for frame in range(count):
        if frame % 50 == 0:
            check()
            progress(frame / count)
        start = frame * hop
        spectrum = np.fft.rfft(padded[start:start+window_size] * window).astype(np.complex64)
        features = np.stack([spectrum.real, spectrum.imag], axis=-1)[None, None].astype(np.float32)
        enhanced, state = session.run([outputs[0].name, outputs[1].name],
            {inputs[0].name: features, inputs[1].name: state})
        bins = enhanced[0, 0]
        wave = np.fft.irfft(bins[:, 0] + 1j * bins[:, 1], n=window_size)
        output[start:start+window_size] += wave * window
        normalization[start:start+window_size] += window ** 2
    valid = normalization > np.finfo(np.float32).tiny
    output[valid] /= normalization[valid]
    # librosa center=True synthesis trims half a window at each end, then
    # upstream discards two complete windows to compensate model lookahead.
    output = output[hop:-hop]
    output = np.concatenate([output[window_size*2:], np.zeros(window_size*2)])
    y = resample(output.astype(np.float32), 48000, rate)
    y = np.pad(y[:len(x)], (0, max(0, len(x)-len(y))))
    if not np.isfinite(y).all():
        raise ValueError('DPDFNet 输出含非有限值')
    progress(1.)
    return y
