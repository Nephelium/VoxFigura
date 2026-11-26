"""Asynchronous, file-backed exports of the local IPA and VoQS recording library."""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import re
import sys
import threading
import time
from uuid import uuid4
import zipfile

import ipa_reference_library as references

CACHE = Path(__file__).resolve().parents[1] / '.cache' / 'ipa-library-materials'
ROUTE = '/models/ipa-references/library-bundle'
_ID = re.compile(r'[A-Za-z0-9_-]+')
_SCHEMA = 'vocalcut-ipa-library-bundle-v1'
_ASSET_ERRORS = (OSError, RuntimeError, ValueError, KeyError, TypeError, ImportError)
_REASON = {
    'not_recorded': '索引尚无录音',
    'source_wav_missing': '索引有录音，但本机原音文件缺失',
    'formal_textgrid_missing': '没有正式人工 TextGrid',
    'reconstruction_not_supported': '该类音段保留实录和标注，暂未纳入当前声道反演',
    'voqs_glottis_only': 'VoQS 录音只有声门反演轨，暂无全声道重合成',
    'trajectory_missing': '没有可用的 50 Hz 反演轨',
    'reconstruction_failed': 'Tract2Vox-Lite 重建或音频对齐未完成',
    'glottis_movie_failed': '声带视频编码未完成',
    'recording_invalid': '原音或标注的时间基准无法读取',
}


@dataclass
class _Job:
    video: bool
    audio_gain: str
    key: str
    path: Path
    total: int
    state: str = 'idle'
    finished: int = 0
    size_bytes: int | None = None
    hint: str | None = None

    def status(self):
        data = {'ok': True, 'state': self.state, 'finished': self.finished, 'total': self.total}
        if self.state == 'ready':
            tag = '1' if self.video else '0'
            data.update(size_bytes=self.size_bytes, download_url=f'/api{ROUTE}/download?video={tag}&audio_gain={self.audio_gain}')
        if self.hint:
            data['hint'] = self.hint
        return data


_jobs: dict[tuple[bool, str], _Job] = {}
_lock = threading.RLock()
_build_lock = threading.Lock()


def _entries():
    return [entry for entry in references.index() if _ID.fullmatch(entry.get('id', ''))]


def _file_mark(path):
    try:
        stat = path.stat()
    except FileNotFoundError:
        return None
    return [stat.st_size, stat.st_mtime_ns]


def _key(entries, video, audio_gain='peak'):
    library = references.LIBRARY
    engine = Path(__file__).resolve().parent
    h = hashlib.sha256(json.dumps([_SCHEMA, video, audio_gain, entries], ensure_ascii=False, sort_keys=True).encode())
    files = [
        Path(__file__), engine / 'ipa_materials.py', engine / 'ipa_reference_library.py',
        engine / 'ipa_glottis_movie.py', engine / 'm27_bridge.py', engine / 'dense_channel.py',
        engine / 'model_bundle' / 'models' / 'manifest.json',
        library / 'trill-demos' / 'index.json',
    ]
    for entry in entries:
        name = entry['id']
        files.extend((
            references.recording_path(entry), library / 'textgrids' / (name + '.TextGrid'),
            (library / ('voqs' if entry.get('voqs') else '')) / (name + '.json'),
        ))
    for demo in references.trill_demos():
        if _ID.fullmatch(demo.get('id', '')):
            files.append(references.trill_audio_path(demo['id']))
    for path in files:
        h.update(json.dumps([path.name, _file_mark(path)]).encode())
    return h.hexdigest()[:24]


def _snapshot(video, entries, audio_gain='peak'):
    key = _key(entries, video, audio_gain)
    path = CACHE / (('video-' if video else 'audio-') + audio_gain + '-' + key + '.zip')
    job = _Job(video, audio_gain, key, path, len(entries))
    if path.is_file():
        job.state = 'ready'
        job.finished = job.total
        job.size_bytes = path.stat().st_size
    return job


def status(video, audio_gain='peak'):
    job_key = (bool(video), audio_gain)
    with _lock:
        if job_key not in _jobs:
            _jobs[job_key] = _snapshot(bool(video), _entries(), audio_gain)
        return _jobs[job_key].status()


def start(video, bridge, retry=False, audio_gain='peak'):
    job_key = (bool(video), audio_gain)
    with _lock:
        job = _jobs.get(job_key)
        if job and job.state == 'building':
            return job.status()
        entries = _entries()
        job = _snapshot(bool(video), entries, audio_gain)
        _jobs[job_key] = job
        if not entries:
            job.state = 'failed'
            job.hint = '本机 IPA / VoQS 录音索引不可用'
        elif job.state != 'ready' or retry:
            job.state = 'building'
            job.finished = 0
            threading.Thread(target=_build, args=(job, entries, bridge), name='ipa-library-zip', daemon=True).start()
        return job.status()


def download(video, audio_gain='peak'):
    job_key = (bool(video), audio_gain)
    with _lock:
        data = status(bool(video), audio_gain)
        job = _jobs[job_key]
        return (job.path if job.state == 'ready' else None), data


def _missing(asset, code):
    return {'asset': asset, 'code': code, 'reason': _REASON[code]}


def _trajectory_json(data):
    return json.loads(data.read_text(encoding='utf-8') if isinstance(data, Path) else data)


def _cached_movie(entry, original, track, rendered):
    from ipa_glottis_movie import render_glottis_movie_file

    signal = rendered if rendered is not None else original
    version = Path(__file__).resolve().with_name('ipa_glottis_movie.py')
    h = hashlib.sha256(json.dumps([entry['id'], entry.get('title'), entry.get('voqs_symbol'), _file_mark(version)]).encode())
    for value in (track, signal):
        if isinstance(value, Path):
            h.update(json.dumps([value.name, _file_mark(value)]).encode())
        else:
            h.update(hashlib.sha256(value).digest())
    directory = CACHE / 'glottis'
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / (entry['id'] + '-' + h.hexdigest()[:24] + '.mp4')
    if target.is_file():
        return target
    output = directory / (uuid4().hex + '.part.mp4')
    try:
        render_glottis_movie_file(entry, _trajectory_json(track), signal, output)
        output.replace(target)
        return target
    finally:
        output.unlink(missing_ok=True)


def _record(entry, video, bridge, audio_gain='peak'):
    from ipa_materials import prepare_materials, source_sample_window

    original = references.recording_path(entry)
    if not original.is_file():
        return None, _missing('original', 'source_wav_missing' if entry.get('exists') else 'not_recorded')
    source_window = source_sample_window(entry, references.LIBRARY, original)
    missing = []
    stage5 = None
    if entry.get('voqs'):
        missing.append(_missing('reconstruction', 'voqs_glottis_only'))
    elif entry.get('excluded'):
        missing.append(_missing('reconstruction', 'reconstruction_not_supported'))
    elif not entry.get('animation'):
        missing.append(_missing('reconstruction', 'trajectory_missing'))
    else:
        try:
            result = references.reconstruction_audio(entry, bridge)
            stage5 = result[0] if result else None
            if stage5 is None:
                missing.append(_missing('reconstruction', 'reconstruction_failed'))
        except _ASSET_ERRORS as error:
            sys.stderr.write(f"[ipa-library] Tract2Vox-Lite {entry['id']}: {type(error).__name__}\n")
            missing.append(_missing('reconstruction', 'reconstruction_failed'))
    try:
        original, grid, track, rendered = prepare_materials(entry, references.LIBRARY, original, stage5, audio_gain=audio_gain)
    except _ASSET_ERRORS:
        if stage5 is None:
            raise
        original, grid, track, rendered = prepare_materials(entry, references.LIBRARY, original, audio_gain=audio_gain)
        missing.append(_missing('reconstruction', 'reconstruction_failed'))
    if stage5 is not None and rendered is None and not any(row['asset'] == 'reconstruction' for row in missing):
        missing.append(_missing('reconstruction', 'reconstruction_failed'))
    if grid is None:
        missing.append(_missing('textgrid', 'formal_textgrid_missing'))
    if track is None:
        missing.append(_missing('trajectory', 'reconstruction_not_supported' if entry.get('excluded') else 'trajectory_missing'))
    movie = None
    if video:
        if track is None:
            missing.append(_missing('glottis_video', 'trajectory_missing'))
        else:
            try:
                movie = _cached_movie(entry, original, track, rendered)
            except _ASSET_ERRORS as error:
                sys.stderr.write(f"[ipa-library] MP4 {entry['id']}: {type(error).__name__}\n")
                missing.append(_missing('glottis_video', 'glottis_movie_failed'))
    prefix = ('voqs' if entry.get('voqs') else 'ipa') + '/' + entry['id'] + '/'
    return (original, grid, track, rendered, movie, prefix, source_window, missing), None


def _write_library(path, job, entries, bridge):
    from ipa_materials import scale_wav_bytes, write_recording

    records, unavailable = [], []
    supplemental = []
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED, compresslevel=3, allowZip64=True) as archive:
        for entry in entries:
            try:
                record, omission = _record(entry, job.video, bridge, job.audio_gain)
            except _ASSET_ERRORS as error:
                sys.stderr.write(f"[ipa-library] material {entry['id']}: {type(error).__name__}\n")
                record, omission = None, _missing('original', 'recording_invalid')
            if record is not None:
                original, grid, track, rendered, movie, prefix, source_window, missing = record
                records.append(write_recording(archive, entry, original, grid, track, rendered, movie,
                    prefix=prefix, missing=missing, source_window=source_window))
            else:
                unavailable.append({'recording': entry['id'], 'title': entry.get('title'),
                                    'kind': 'voqs' if entry.get('voqs') else 'ipa', **omission})
            with _lock:
                job.finished += 1
        for demo in references.trill_demos():
            name = demo.get('id', '')
            if not _ID.fullmatch(name):
                continue
            audio = references.trill_audio_path(name)
            if audio.is_file():
                file = 'demo/trills/' + name + '.wav'
                archive.writestr(file, scale_wav_bytes(audio, audio_gain=job.audio_gain))
                supplemental.append({**demo, 'file': file, 'kind': 'synthesized_demo',
                                     'source_audio_encoding': audio.suffix[1:].upper()})
        counts = Counter(item['kind'] for item in records)
        files = Counter(key for item in records for key in item['files'])
        missing = Counter(item['code'] for item in unavailable)
        missing.update(item['code'] for record in records for item in record['missing'])
        manifest = {
            'schema': _SCHEMA, 'created_unix_s': int(time.time()), 'include_video': job.video,
            'scope': '本机 IPA 与 VoQS 实录。颤音合成参考另存 demo/trills，不计入实录数。',
            'counts': {'catalogued': len(entries), 'recorded': len(records), **counts,
                       'unavailable_recordings': len(unavailable), 'supplemental_demos': len(supplemental)},
            'files': dict(files), 'missing_counts': dict(missing), 'records': records,
            'unavailable_recordings': unavailable, 'supplemental_demos': supplemental,
        }
        archive.writestr('manifest.json', json.dumps(manifest, ensure_ascii=False, indent=2))
    if not records:
        raise ValueError('本机录音库没有可读取的 IPA / VoQS 实录')


def _build(job, entries, bridge):
    with _build_lock:
        path = CACHE / (uuid4().hex + '.part.zip')
        try:
            CACHE.mkdir(parents=True, exist_ok=True)
            _write_library(path, job, entries, bridge)
            path.replace(job.path)
            size = job.path.stat().st_size
            with _lock:
                job.state = 'ready'
                job.size_bytes = size
        except Exception as error:
            with _lock:
                job.state = 'failed'
                job.hint = str(error) if isinstance(error, ValueError) else '本机未完成全库资料打包'
            sys.stderr.write(f'[ipa-library] archive: {type(error).__name__}\n')
        finally:
            path.unlink(missing_ok=True)
