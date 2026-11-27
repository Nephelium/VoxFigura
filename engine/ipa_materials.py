"""Prepare playable IPA material on a shared, sample-accurate timebase."""
from bisect import bisect_right
from dataclasses import dataclass
from functools import lru_cache
from io import BytesIO
import json
import math
from pathlib import Path
import re
import struct
import zipfile

import numpy as np
from scipy.signal import resample_poly
import soundfile as sf


def _wave_input(audio):
    return BytesIO(audio) if isinstance(audio, bytes) else audio


def _is_mp3_path(audio):
    return isinstance(audio, Path) and audio.suffix.lower() == '.mp3'


def align_wave(generated, reference, *, audio_gain="peak"):
    info = sf.info(_wave_input(reference))
    signal, rate = sf.read(_wave_input(generated), dtype='float32', always_2d=True)
    if rate != info.samplerate:
        common = math.gcd(rate, info.samplerate)
        signal = resample_poly(signal, info.samplerate // common, rate // common, axis=0)
    aligned = np.zeros((info.frames, signal.shape[1]), dtype='float32')
    n = min(len(signal), info.frames)
    aligned[:n] = signal[:n]
    if audio_gain != "original":
        from dense_channel import apply_synthesis_gain
        aligned = apply_synthesis_gain(aligned, audio_gain).astype('float32')
    out = BytesIO()
    sf.write(out, aligned, info.samplerate, format='WAV', subtype='PCM_16')
    return out.getvalue()


def scale_wav_bytes(audio, *, audio_gain="peak"):
    """Return WAV bytes uniformly peak-scaled to 0.8 unless audio_gain is 'original'."""
    if audio_gain == "original" and not _is_mp3_path(audio):
        return audio.read_bytes() if isinstance(audio, Path) else audio

    with sf.SoundFile(_wave_input(audio)) as source:
        samples = source.read(dtype='float64', always_2d=True)
        rate = source.samplerate
        subtype = 'FLOAT' if source.format == 'MP3' else source.subtype
    if audio_gain != "original":
        from dense_channel import apply_synthesis_gain
        samples = apply_synthesis_gain(samples, audio_gain)
    out_subtype = subtype if subtype in ('PCM_16', 'PCM_24', 'PCM_32', 'FLOAT', 'DOUBLE') else 'PCM_16'
    out = BytesIO()
    sf.write(out, samples, rate, format='WAV', subtype=out_subtype)
    wav = out.getvalue()
    return _remove_peak_chunk(wav) if out_subtype in ('FLOAT', 'DOUBLE') else wav


def recording_files(entry, library):
    item = entry['id']
    grid = library / 'textgrids' / (item + '.TextGrid')
    track = (library / 'voqs' if entry.get('voqs') else library) / (item + '.json')
    return (
        grid if grid.is_file() else None,
        track if track.is_file() and not entry['excluded'] else None,
    )


@dataclass(frozen=True)
class RecordingWindow:
    start: int
    end: int
    rate: int
    frames: int

    @property
    def duration(self):
        return (self.end - self.start) / self.rate

    @property
    def cropped(self):
        return self.start > 0 or self.end < self.frames

    def sample(self, time):
        return min(self.frames, max(0, round(float(time) * self.rate)))


_TIER = re.compile(r"(?m)^\s*item \[\d+\]:")
_INTERVAL = re.compile(
    r'intervals \[\d+\]:\s*xmin\s*=\s*(\S+)\s*xmax\s*=\s*(\S+)\s*text\s*=\s*"((?:""|[^"])*)"'
)
_TIER_NAME = re.compile(r'\bname\s*=\s*"((?:""|[^"])*)"')


@lru_cache(maxsize=512)
def _read_formal_grid(path, _mtime):
    data = path.read_bytes()
    encoding = "utf-16" if data.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8-sig"
    tiers = []
    for item in _TIER.split(data.decode(encoding))[1:]:
        name = _TIER_NAME.search(item)
        if not name or 'class = "IntervalTier"' not in item:
            raise ValueError(f"无法读取正式标注层 {path.name}")
        intervals = tuple((float(a), float(b), value.replace('""', '"')) for a, b, value in _INTERVAL.findall(item))
        tiers.append((name[1].replace('""', '"'), intervals))
    if not tiers:
        raise ValueError(f"缺少可读取的正式标注层 {path.name}")
    return tuple(tiers)


@lru_cache(maxsize=512)
def _cached_audio_info(path_str: str, _mtime_ns: int, _size: int):
    info = sf.info(path_str)
    return info.frames, info.samplerate


def _audio_frames_and_rate(audio):
    if isinstance(audio, Path):
        st = audio.stat()
        return _cached_audio_info(str(audio), st.st_mtime_ns, st.st_size)
    info = sf.info(_wave_input(audio))
    return info.frames, info.samplerate


def _formal_window(original, grid):
    frames, samplerate = _audio_frames_and_rate(original)
    full = RecordingWindow(0, frames, samplerate, frames)
    tiers = _read_formal_grid(grid, grid.stat().st_mtime_ns) if grid else ()
    labeled = [(a, b) for _, intervals in tiers for a, b, label in intervals if label.strip()]
    if not labeled:
        return full, tiers
    padding = full.rate // 10
    return RecordingWindow(
        max(0, full.sample(min(a for a, _ in labeled)) - padding),
        min(full.frames, full.sample(max(b for _, b in labeled)) + padding),
        full.rate, full.frames,
    ), tiers


def _local_intervals(window, intervals):
    for start, end, label in intervals:
        a = max(window.start, window.sample(start))
        b = min(window.end, window.sample(end))
        if a < b:
            yield (a - window.start) / window.rate, (b - window.start) / window.rate, label


def _cropped_textgrid(window, tiers):
    duration = format(window.duration, '.15g')
    lines = ['File type = "ooTextFile"', 'Object class = "TextGrid"', '',
             'xmin = 0', f'xmax = {duration}', 'tiers? <exists>', f'size = {len(tiers)}', 'item []:']
    for index, (name, source_intervals) in enumerate(tiers, 1):
        label = name.replace('"', '""')
        intervals = []
        position = 0.0
        for start, end, text in _local_intervals(window, source_intervals):
            if start > position:
                intervals.append((position, start, ""))
            if max(start, position) < end:
                intervals.append((max(start, position), end, text))
                position = end
        if position < window.duration:
            intervals.append((position, window.duration, ""))
        lines.extend([f'    item [{index}]:', '        class = "IntervalTier"', f'        name = "{label}"',
                      '        xmin = 0', f'        xmax = {duration}', f'        intervals: size = {len(intervals)}'])
        for n, (start, end, text) in enumerate(intervals, 1):
            quote = text.replace('"', '""')
            lines.extend([f'        intervals [{n}]:', f'            xmin = {start:.15g}',
                          f'            xmax = {end:.15g}', f'            text = "{quote}"'])
    return ("\n".join(lines) + "\n").encode('utf-8')


def material_times(entry, library, original):
    """List timing in the same coordinate system as the audio route."""
    grid = library / 'textgrids' / (entry['id'] + '.TextGrid')
    if not grid.is_file() or not original.is_file():
        return {}
    window, tiers = _formal_window(original, grid)
    phones = next((intervals for name, intervals in tiers if name.lower() in ('phone', 'phones')), ())
    labeled = [(a, b, label) for a, b, label in _local_intervals(window, phones) if label.strip()]
    if not labeled:
        return {}
    fields = {'duration_s': window.duration, 'trim_start_s': window.start / window.rate}
    if entry.get('voqs'):
        fields['voqs_intervals'] = [{'start_s': a, 'end_s': b} for a, b, _ in labeled]
    else:
        fields['phones'] = [{'start_s': a, 'end_s': b, 'label': label} for a, b, label in labeled]
    return fields


def source_sample_window(entry, library, original):
    """Map the exported zero point back to the indexed recording."""
    grid = library / 'textgrids' / (entry['id'] + '.TextGrid')
    window, tiers = _formal_window(original, grid if grid.is_file() else None)
    annotated = [(window.sample(a), window.sample(b)) for _, intervals in tiers for a, b, text in intervals if text.strip()]
    return {
        'sample_rate_hz': window.rate,
        'source_sample_count': window.frames,
        'source_start_sample': window.start,
        'source_end_sample_exclusive': window.end,
        'padding_limit_s': 0.1 if annotated else None,
        'left_padding_samples': min(a for a, _ in annotated) - window.start if annotated else None,
        'right_padding_samples': window.end - max(b for _, b in annotated) if annotated else None,
        **({'source_audio_encoding': 'MP3'} if _is_mp3_path(original) else {}),
    }


def _crop_wave(audio, window, *, audio_gain="peak"):
    if not window.cropped:
        if audio_gain != "original" or _is_mp3_path(audio):
            return scale_wav_bytes(audio, audio_gain=audio_gain)
        return audio
    with sf.SoundFile(_wave_input(audio)) as source:
        source.seek(window.start)
        subtype = 'FLOAT' if source.format == 'MP3' else source.subtype
        if audio_gain != "original":
            samples = source.read(window.end - window.start, dtype='float64', always_2d=True)
            from dense_channel import apply_synthesis_gain
            samples = apply_synthesis_gain(samples, audio_gain)
        else:
            if subtype == "PCM_16":
                dtype = 'int16'
            elif subtype in ('PCM_24', 'PCM_32'):
                dtype = 'int32'
            else:
                dtype = 'float64'
            samples = source.read(window.end - window.start, dtype=dtype, always_2d=True)
    out_subtype = subtype if subtype in ('PCM_16', 'PCM_24', 'PCM_32', 'FLOAT', 'DOUBLE') else 'PCM_16'
    out = BytesIO()
    sf.write(out, samples, window.rate, format='WAV', subtype=out_subtype)
    wav = out.getvalue()
    return _remove_peak_chunk(wav) if out_subtype in ('FLOAT', 'DOUBLE') else wav


def _remove_peak_chunk(wav):
    # libsndfile puts the write time in optional float-WAV PEAK metadata.
    # Strip that chunk while retaining the fmt/fact/data chunks bit for bit.
    offset = 12
    while offset + 8 <= len(wav):
        tag, length = struct.unpack_from('<4sI', wav, offset)
        end = offset + 8 + length + (length % 2)
        if tag == b'PEAK':
            content = wav[:offset] + wav[end:]
            return content[:4] + struct.pack('<I', len(content) - 8) + content[8:]
        offset = end
    return wav


def _clock(window, hz):
    return np.arange(math.ceil(window.duration * hz - 1e-10), dtype=np.float64) / hz


def _crop_rows(rows, window, hz):
    values = np.asarray(rows, dtype=np.float64)
    source = np.arange(len(values)) / hz
    target = window.start / window.rate + _clock(window, hz)
    return np.round(np.column_stack([np.interp(target, source, column) for column in values.T]), 7).tolist()


def _animation_pose(frames, frame_times, t):
    i = bisect_right(frame_times, t)
    if i == 0 or i >= len(frames):
        return dict(frames[0 if i == 0 else -1])
    a, b = frames[i - 1], frames[i]
    weight = (t - frame_times[i - 1]) / (frame_times[i] - frame_times[i - 1])
    pose = dict(a if weight < .5 else b)
    for field, first in a.items():
        second = b.get(field)
        if field in ('t', 'voiced', 'frib'):
            continue
        if isinstance(first, (float, int)) and isinstance(second, (float, int)):
            pose[field] = round(first + (second - first) * weight, 7)
        elif isinstance(first, list) and isinstance(second, list) and len(first) == len(second):
            pose[field] = [round(x + (y - x) * weight, 7) for x, y in zip(first, second)]
    return pose


def _crop_track(path, window):
    if not window.cropped:
        return path
    data = json.loads(path.read_text(encoding='utf-8'))
    for key in ('m27_50hz_pa', 'glottis_50hz_pa'):
        if data.get(key):
            data[key] = _crop_rows(data[key], window, 50)
    animation = data.get('animation')
    if animation and animation.get('frames'):
        frames = animation['frames']
        frame_times = [frame['t'] for frame in frames]
        new = []
        for time in _clock(window, animation['fps']):
            frame = _animation_pose(frames, frame_times, window.start / window.rate + time)
            frame['t'] = round(float(time), 9)
            new.append(frame)
        animation.update(frames=new, frame_count=len(new), duration_sec=window.duration)
    return json.dumps(data, ensure_ascii=False, separators=(',', ':')).encode('utf-8')


def prepare_materials(entry, library, original, generated=None, *, audio_gain="peak"):
    """Return matching original WAV, TextGrid, trajectory JSON and rendered WAV."""
    grid, track = recording_files(entry, library)
    window, tiers = _formal_window(original, grid)
    rendered = align_wave(generated, original, audio_gain="original") if generated is not None else None
    return (
        _crop_wave(original, window, audio_gain=audio_gain),
        _cropped_textgrid(window, tiers) if grid and window.cropped else grid,
        _crop_track(track, window) if track else None,
        _crop_wave(rendered, window, audio_gain=audio_gain) if rendered is not None else None,
    )


def write_recording(archive, entry, original, grid, track, rendered=None, movie=None, *, prefix='', missing=None, source_window=None):
    item = entry['id']
    info = sf.info(_wave_input(original))
    meta = {
        'recording': item, 'title': entry.get('title', item), 'prompt': entry['prompt'], 'group': entry.get('group', ''),
        'kind': 'voqs' if entry.get('voqs') else 'ipa',
        'sample_rate_hz': info.samplerate, 'sample_count': info.frames, 'duration_s': info.duration,
        'formal_textgrid': grid is not None,
        'annotation_source': '正式人工标注，各边界取最近的原音采样' if grid else '录音工程无正式 TextGrid',
        'reconstruction': 'Tract2Vox-Lite' if rendered is not None else None,
        'trajectory_hz': 50 if track else None,
        'movie': '声门模型频闪示意' if movie is not None else None,
        'movie_audio': ('reconstruction' if rendered is not None else 'original') if movie is not None else None,
    }
    if source_window is not None:
        meta['source_window'] = source_window
    if entry.get('trimmed_prefix'):
        meta['removed_prefix'] = entry['trimmed_prefix']
    if entry.get('issue'):
        meta['source_note'] = entry['issue']
    if missing is not None:
        meta['missing'] = missing

    files = {}
    for kind, data, name in (
        ('original', original, item + '.wav'),
        ('textgrid', grid, item + '.TextGrid'),
        ('reconstruction', rendered, item + '-reconstruction.wav'),
        ('reconstruction_textgrid', grid if rendered is not None else None, item + '-reconstruction.TextGrid'),
        ('trajectory', track, item + ('-glottis.json' if entry.get('voqs') else '-trajectory.json')),
        ('glottis_video', movie, item + '-glottis.mp4'),
    ):
        if data is None:
            continue
        files[kind] = prefix + name
        if isinstance(data, Path):
            archive.write(data, files[kind], compress_type=zipfile.ZIP_STORED if kind == 'glottis_video' else None)
        else:
            archive.writestr(files[kind], data, compress_type=zipfile.ZIP_STORED if kind == 'glottis_video' else None)
    files['manifest'] = prefix + 'manifest.json'
    meta['files'] = files
    archive.writestr(files['manifest'], json.dumps(meta, ensure_ascii=False, indent=2))
    return meta


def material_zip(entry, library, original, generated=None, include_movie=False, *, audio_gain="peak"):
    source_window = source_sample_window(entry, library, original)
    original, grid, track, rendered = prepare_materials(entry, library, original, generated, audio_gain=audio_gain)
    movie = None
    if include_movie:
        if track is None:
            raise ValueError('此录音没有可显示的声门轨迹')
        from ipa_glottis_movie import render_glottis_movie
        trajectory = json.loads(track.read_text(encoding='utf-8') if isinstance(track, Path) else track)
        movie = render_glottis_movie(entry, trajectory, rendered or original)
    output = BytesIO()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED, compresslevel=3) as archive:
        write_recording(archive, entry, original, grid, track, rendered, movie, source_window=source_window)
    return output.getvalue(), 'application/zip'
