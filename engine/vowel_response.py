"""Measure the first three stable VTL transfer peaks in annotated IPA vowel cores."""
from __future__ import annotations

from collections import OrderedDict
import hashlib
import json
import math
from pathlib import Path
import re
import threading
import unicodedata
import xml.etree.ElementTree as ET

import numpy as np

from dense_channel import VTL_NATIVE_DIR
from phonetic_core.vocal_tract.engine import Engine
from phonetic_core.vocal_tract.preset_adaptation import VOWELS

SECTION_COUNT = 65
CORE_FRACTIONS = (.3, .7)
CONTROL_HZ = 50
NASAL_PORT_CM2 = .01
MIN_STABLE_FRAMES = 4
SPEAKERS = ('JD2', 'W02', 'M01', 'JD2-2D', 'W02-2D')
METHOD = 'vtl-hf-textgrid-core-v1'
GEOMETRY = 'm10/r21'
DEFAULT_FILE = 'vowel-transfer-jd2-65.json'
_VOWELS = frozenset('iyɨʉɯuɪʏʊeøɘɵɤoəɛœɜɞʌɔæɐaᴀɶɑɒɚɝɿʅ') | {'a\u0308'}
_ID = re.compile(r'[A-Za-z0-9_-]+')
_cache = OrderedDict()
_lock = threading.Lock()
_speaker_locks = {speaker: threading.Lock() for speaker in SPEAKERS}


def _vowel_mark(record):
    match = re.match(r'^\[([^]]+)\]', record.get('title', ''))
    symbol = unicodedata.normalize('NFC', match[1]) if match else ''
    base = unicodedata.normalize('NFD', symbol).removesuffix('\u0303')
    return symbol if base in _VOWELS else ''


def _candidates(records, library):
    result = []
    for record in records:
        if record.get('excluded') or record.get('voqs') or not _ID.fullmatch(record.get('id', '')):
            continue
        symbol = _vowel_mark(record)
        if not symbol or '元音' not in record.get('group', ''):
            continue
        phones = [phone for phone in record.get('phones', [])
                  if unicodedata.normalize('NFC', phone['label']) == symbol]
        path = library / (record['id'] + '.json')
        mark = [phones[0]['start_s'], phones[0]['end_s']] if len(phones) == 1 else None
        result.append((record['id'], symbol, mark, path))
    return result


def _signature(candidates):
    h = hashlib.sha256(METHOD.encode())
    for identifier, symbol, mark, path in candidates:
        h.update(json.dumps([identifier, symbol, mark], ensure_ascii=False).encode())
        if path.is_file():
            h.update(hashlib.sha256(path.read_bytes()).digest())
    return h.hexdigest()


class _AnatomicalTransfer:
    """Carry deviations from common native landmarks to the requested anatomy."""
    def __init__(self, engine):
        self.engine = engine

        def read_shapes(path):
            shapes = ET.parse(path).findall('.//vocal_tract_model/shapes/shape')
            return {shape.get('name'): {param.get('name'): float(param.get('value'))
                                       for param in shape.findall('param')} for shape in shapes}

        baseline, target = read_shapes(engine.resource_dir / 'JD2.speaker'), read_shapes(engine.speaker_path)
        self.keys = sorted(baseline.keys() & target.keys())
        self.source = np.array([[baseline[key][name] for name in engine.names] for key in self.keys])
        self.target = np.array([[target[key][name] for name in engine.names] for key in self.keys])

    def apply(self, frame, symbol):
        native = VOWELS.get(symbol, symbol)
        if native in self.keys:
            index = self.keys.index(native)
        else:
            differences = (self.source - frame) / (self.engine.maximum - self.engine.minimum)
            differences[:, 14:16] = 0  # M27 estimates 17 independent controls with automatic root.
            index = int(np.argmin(np.linalg.norm(differences, axis=1)))
        return self.target[index] + (frame - self.source[index])


def _measure_span(engine, rows, start, end, symbol, transfer):
    pairs, ports = [], []
    available = 0
    first = max(0, math.ceil(start * CONTROL_HZ))
    last = min(len(rows), math.ceil(end * CONTROL_HZ))
    for row in rows[first:last]:
        if not np.isfinite(row[:17]).all():
            continue
        available += 1
        frame = np.r_[row[:14], engine.neutral[14:16], row[14:17]]
        if transfer is not None:
            frame = transfer.apply(frame, symbol)
        peaks, area = engine.reference_formants(frame, 1., 0., None, None)
        if peaks is not None and len(peaks) >= 3 and math.isfinite(area) and 100 <= peaks[0] < peaks[1] <= 5000 and peaks[1] < peaks[2] <= 6000:
            pairs.append(peaks[:3])
            ports.append(area)
    if len(pairs) < MIN_STABLE_FRAMES:
        return None, available
    values = np.asarray(pairs)
    port = np.asarray(ports)
    nasal = bool(np.median(port) > NASAL_PORT_CM2)
    same_coupling = (port > NASAL_PORT_CM2) == nasal
    values, port = values[same_coupling], port[same_coupling]
    center = np.median(values, axis=0)
    mad = np.median(abs(values - center), axis=0)
    keep = np.all(abs(values - center) <= np.maximum([75, 150, 225], 4 * mad), axis=1)
    stable = values[keep]
    if len(stable) < MIN_STABLE_FRAMES:
        return None, available
    f1, f2, f3 = np.median(stable, axis=0)
    return {
        'f1': round(float(f1), 1), 'f2': round(float(f2), 1), 'f3': round(float(f3), 1),
        'frames': len(stable), 'nasal': nasal, 'nasal_port_cm2': round(float(np.median(port[keep])), 5),
        'core_start_s': round(start, 5), 'core_end_s': round(end, 5),
    }, available


def _measure(candidates, speaker, signature):
    records, omitted = [], []
    engine = None
    try:
        for identifier, symbol, mark, path in candidates:
            entry = {'id': identifier, 'symbol': symbol}
            if not mark or not all(math.isfinite(n) for n in mark) or mark[0] < 0 or mark[1] <= mark[0]:
                omitted.append({**entry, 'code': 'missing_annotation'})
                continue
            if not path.is_file():
                omitted.append({**entry, 'code': 'missing_track'})
                continue
            try:
                rows = np.asarray(json.loads(path.read_text(encoding='utf-8'))['m27_50hz_pa'], dtype=float)
                if rows.ndim != 2 or rows.shape[1] != 27:
                    raise ValueError('Invalid M27 controls')
            except (OSError, ValueError, KeyError, TypeError):
                omitted.append({**entry, 'code': 'missing_track'})
                continue
            if engine is None:
                engine = Engine(speaker, resource_dir=VTL_NATIVE_DIR)
                engine.set_section_count(SECTION_COUNT)
                engine.set_manual_root(False)
                adaptation = _AnatomicalTransfer(engine) if speaker.removesuffix('-2D') != 'JD2' else None
            start, end = mark
            left, right = (start + (end - start) * fraction for fraction in CORE_FRACTIONS)
            data, available = _measure_span(engine, rows, left, right, symbol, adaptation)
            if data:
                records.append({**entry, **data})
            else:
                omitted.append({**entry, 'code': 'missing_track' if available < MIN_STABLE_FRAMES else 'missing_peaks'})
    finally:
        if engine is not None:
            engine.close()
    return {
        'method': METHOD, 'geometry_method': GEOMETRY, 'speaker': speaker, 'section_count': SECTION_COUNT,
        'source_geometry': 'JD2', 'anatomy_adaptation': 'native_landmarks' if speaker.removesuffix('-2D') != 'JD2' else 'none',
        'signature': signature, 'core_fraction': CORE_FRACTIONS, 'step_hz': CONTROL_HZ, 'records': records, 'omitted': omitted,
    }


def measures(records, library: Path, speaker: str, *, force=False):
    if speaker not in SPEAKERS:
        raise ValueError('不支持的解剖说话人')
    with _speaker_locks[speaker]:
        candidates = _candidates(records, library)
        signature = _signature(candidates)
        key = speaker, signature, library
        with _lock:
            if key in _cache and not force:
                _cache.move_to_end(key)
                return _cache[key]
        precomputed = library / DEFAULT_FILE
        content = None
        if speaker == 'JD2' and precomputed.is_file() and not force:
            try:
                asset = json.loads(precomputed.read_text(encoding='utf-8'))
                # Transitional assets also carry the signature understood by an already running engine.
                asset_signature = asset.get('full_signature', asset['signature'])
                if (asset['method'], asset['geometry_method'], asset['speaker'], asset['section_count'], asset_signature) == (
                    METHOD, GEOMETRY, speaker, SECTION_COUNT, signature,
                ) and all('f3' in r for r in asset.get('records', ())):
                    content = asset
            except (OSError, KeyError, ValueError, TypeError):
                pass
        if content is None:
            content = _measure(candidates, speaker, signature)
        with _lock:
            _cache[key] = content
            _cache.move_to_end(key)
            if len(_cache) > len(SPEAKERS):
                _cache.popitem(last=False)
        return content


def measure_saved_poses(speaker, poses, dense_manager=None):
    """Check explicitly authored kit poses reusing the pooled engine when available."""
    if speaker not in SPEAKERS:
        raise ValueError('不支持的解剖说话人')
    if not isinstance(poses, list) or not 1 <= len(poses) <= 40:
        raise ValueError('每批参考构型数量应为 1 至 40')
    records, omitted = [], []

    def _run(eng):
        for pose in poses:
            if not isinstance(pose, dict) or not isinstance(pose.get('symbol'), str):
                raise ValueError('无效的参考构型')
            symbol = pose['symbol']
            try:
                eng.set_manual_root(bool(pose.get('manual_root', False)))
                peaks, port = eng.reference_formants(
                    pose.get('params'), float(pose.get('lip_width', 1)),
                    pose.get('larynx_height', 0), pose.get('tongue_shape'), pose.get('lip_shape'),
                )
            except (ValueError, TypeError, KeyError):
                omitted.append({'symbol': symbol, 'code': 'invalid_pose'})
                continue
            if peaks and len(peaks) >= 3 and math.isfinite(port):
                records.append({'symbol': symbol, 'f1': peaks[0], 'f2': peaks[1], 'f3': peaks[2], 'nasal': port > NASAL_PORT_CM2})
            else:
                omitted.append({'symbol': symbol, 'code': 'missing_peaks'})

    if dense_manager is not None:
        with dense_manager.lease(speaker, manual_root=False, section_count=SECTION_COUNT) as eng:
            _run(eng)
    else:
        eng = Engine(speaker, resource_dir=VTL_NATIVE_DIR)
        try:
            eng.set_section_count(SECTION_COUNT)
            _run(eng)
        finally:
            eng.close()
    return {'speaker': speaker, 'section_count': SECTION_COUNT, 'records': records, 'omitted': omitted}

