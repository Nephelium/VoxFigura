"""VoQS playback from recorded source estimates with the native VTL glottis."""
from __future__ import annotations

import base64
import json
from pathlib import Path
import re
import threading

import numpy as np
import soundfile as sf

from dense_channel import (
    F0_MIN_HZ, F0_MAX_HZ, PRESSURE_MIN_PA, PRESSURE_MAX_PA, SAMPLE_RATE_HZ,
    VOQS_NATIVE_F0_MIN_HZ,
)
from ipa_materials import _wave_input, align_wave, prepare_materials
from ipa_reference_library import LIBRARY, index, recording_path
from validation import GLOTTIS8_MIN, GLOTTIS8_MAX
from voqs_creak import is_creaky_symbol

ROUTE = re.compile(r"/models/ipa-references/([A-Za-z0-9_-]+)/(voqs-track|voqs-reconstruction)$")
COLUMNS = ('f0_hz', 'pr_pa', 'xb_cm', 'xt_cm', 'ca_cm2', 'lag_rad', 'ra', 'ps', 'fl', 'shim')
RATE = 50
HEIGHTS = {'L̝': .5, 'L̞': -.5}
CARRIER = 'VTL 2.4 固定 [ə] 管腔'
VOQS_NATIVE_CACHE = Path(__file__).resolve().parents[1] / '.cache' / 'voqs-native'
_VOQS_CACHE_LOCK = threading.Lock()


def _recording(identifier):
    entry = next((item for item in index() if item['id'] == identifier and item.get('voqs') and item['exists']), None)
    if entry is None:
        return None
    wave = recording_path(entry)
    if not wave.is_file():
        return None
    original, _, track, _ = prepare_materials(entry, LIBRARY, wave, audio_gain='original')
    if track is None:
        return None
    data = json.loads(track.read_text(encoding='utf-8') if isinstance(track, Path) else track)
    estimates = np.asarray(data['glottis_50hz_pa'], dtype=np.float64)
    if estimates.ndim != 2 or estimates.shape[1] != len(COLUMNS) or not len(estimates):
        raise ValueError('无可读的 50 Hz 声门控制轨')
    return entry, original, estimates


def _usable(rows, f0_min_hz=F0_MIN_HZ):
    model_low = [f0_min_hz, PRESSURE_MIN_PA, *GLOTTIS8_MIN]
    model_high = [F0_MAX_HZ, PRESSURE_MAX_PA, *GLOTTIS8_MAX]
    return np.all(np.isfinite(rows) & (rows >= model_low) & (rows <= model_high), axis=1)


def track(identifier):
    result = _recording(identifier)
    if result is None:
        return None
    entry, original, estimates = result
    info = sf.info(_wave_input(original))
    rows = [[float(value) if np.isfinite(value) else None for value in row] for row in estimates]
    f0_min_hz = VOQS_NATIVE_F0_MIN_HZ if is_creaky_symbol(entry.get('voqs_symbol')) else F0_MIN_HZ
    usable = _usable(estimates, f0_min_hz)
    frame_count = (info.frames * RATE + info.samplerate - 1) // info.samplerate
    return {
        'ok': True, 'id': identifier, 'symbol': entry.get('voqs_symbol'), 'analysis': 'M27 声门参数反演估计',
        'columns': COLUMNS, 'step_hz': RATE, 'start_s': 0, 'duration_s': info.duration,
        'sample_rate_hz': info.samplerate, 'sample_count': info.frames, 'rows': rows,
        'out_of_range_frames': int(np.count_nonzero(~usable)),
        'has_native_audio': bool(info.duration <= 60 and np.any(usable[:frame_count] & (estimates[:frame_count, 1] > 0))),
        'missing_frames': max(0, frame_count - len(rows)),
        'larynx_height_cm': HEIGHTS.get(entry.get('voqs_symbol')), 'larynx_height_measured': False,
        'carrier': CARRIER,
    }


def reconstruction(identifier, manager, speaker, height=None, audio_gain='peak'):
    result = _recording(identifier)
    if result is None:
        return None
    if speaker not in ('JD2', 'W02', 'M01', 'JD2-2D', 'W02-2D'):
        raise ValueError('不支持所选 VTL 解剖说话人')
    if audio_gain not in ('peak', 'original'):
        raise ValueError('音量模式应为自动增益或原始电平')
    entry, original, estimates = result
    nominal = HEIGHTS.get(entry.get('voqs_symbol'))
    is_default_height = height is None
    height = (nominal or 0) if height is None else float(height)
    if not np.isfinite(height) or not -1 <= height <= 1:
        raise ValueError('喉位控制量限于 -1 至 1 cm')
    if (nominal is None and height != 0) or (nominal is not None and nominal * height <= 0):
        raise ValueError('喉位须符合当前 VoQS 高低方向')
    height_tag = '' if is_default_height else f'-h{height:+.2f}'
    source_wave = recording_path(entry) if entry.get('id') else None
    source_track = LIBRARY / 'voqs' / f'{identifier}.json'
    can_cache = bool(source_wave and source_wave.is_file() and source_track.is_file())
    cache_file = VOQS_NATIVE_CACHE / f'{identifier}-{speaker}{height_tag}-{audio_gain}.wav'
    if can_cache and cache_file.is_file():
        source_mtime = max(source_wave.stat().st_mtime_ns, source_track.stat().st_mtime_ns)
        if cache_file.stat().st_mtime_ns >= source_mtime:
            return cache_file.read_bytes()
    info = sf.info(_wave_input(original))
    duration = info.frames / info.samplerate
    if not 0 < duration <= 60:
        raise ValueError('重合成只支持 60 秒以内的参考段')
    samples = round(duration * SAMPLE_RATE_HZ)
    frame_count = (samples + SAMPLE_RATE_HZ // RATE - 1) // (SAMPLE_RATE_HZ // RATE)
    use_creaky_source = is_creaky_symbol(entry.get('voqs_symbol'))
    with manager.lease(speaker) as engine:
        carrier = engine.preset('@')
        neutral = engine.gneutral.copy()
        f0_min_hz = max(VOQS_NATIVE_F0_MIN_HZ, float(engine.gmin[0])) if use_creaky_source else F0_MIN_HZ
    rows = np.empty((frame_count, len(COLUMNS)), dtype=float)
    # The analysis may end up to one hop short of the PCM reference. Keep the
    # time base and exclude unavailable rows from the native source.
    rows[:] = [neutral[0], 0., *neutral[2:], 0.]
    limit = min(len(estimates), len(rows))
    usable = _usable(estimates[:limit], f0_min_hz)
    rows[np.flatnonzero(usable)] = estimates[:limit][usable]
    if not np.any(rows[:, 1] > 0):
        raise ValueError('参考录音没有可用的 VTL 原生合成有声帧')
    native = _render_native(manager, speaker, height, carrier, rows, samples, use_creaky_source, audio_gain='original')
    wav_bytes = align_wave(native, original, audio_gain=audio_gain)
    if can_cache:
        with _VOQS_CACHE_LOCK:
            try:
                cache_file.parent.mkdir(parents=True, exist_ok=True)
                tmp = cache_file.with_suffix('.tmp')
                tmp.write_bytes(wav_bytes)
                tmp.replace(cache_file)
            except OSError:
                pass
    return wav_bytes


def _render_native(manager, speaker, height, carrier, rows, samples, use_creaky_source, *, audio_gain='peak'):
    body = {
        'speaker': speaker, 'step_hz': RATE, 'sample_count': samples, 'include_geometry': False,
        'f0_hz': rows[:,0].tolist(), 'pressure_pa': rows[:,1].tolist(),
        'tract_frames': [carrier.tolist()] * len(rows), 'larynx_height_frames': [height] * len(rows),
        'glottis_frames': rows[:,2:].tolist(), 'per_frame_shimmer': True, 'seed': 20261120,
        'audio_gain': audio_gain,
    }
    rendered = manager.synthesize_dense(body, voqs_reference=use_creaky_source)
    if not rendered.get('ok'):
        raise ValueError(rendered.get('error', {}).get('hint', 'VTL 未能生成录音'))
    return base64.b64decode(rendered['wav_base64'])

