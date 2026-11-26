"""M27 vocal-fold visualisation at recording time, with a slowed display phase."""

from __future__ import annotations

from importlib.machinery import PathFinder
from importlib.util import module_from_spec
from io import BytesIO
from math import ceil, log, pi, sin, sqrt
import os
from pathlib import Path
import subprocess
import sys
import sysconfig
from tempfile import TemporaryDirectory

import numpy as np
import soundfile as sf


def _load_bundled_pillow():
    if sys.version_info[:2] != (3, 11) or sysconfig.get_platform() != "win-amd64":
        return
    local_dependencies = Path(__file__).resolve().parent / "vendor" / "python-cp311-win_amd64"
    spec = PathFinder.find_spec("PIL", [str(local_dependencies)])
    if spec is None or spec.loader is None:
        return
    package = module_from_spec(spec)
    sys.modules["PIL"] = package
    try:
        spec.loader.exec_module(package)
    except Exception:
        sys.modules.pop("PIL", None)
        raise


try:
    import PIL
except ModuleNotFoundError as error:
    if error.name != "PIL":
        raise
    _load_bundled_pillow()

from PIL import Image, ImageDraw, ImageFont

FPS = 30
WIDTH, HEIGHT = 768, 468
FIELDS = ("f0", "pr_pa", "xb", "xt", "ca", "lag", "ra", "ps", "fl", "shim")
IPA_FONT = Path(__file__).resolve().parents[1] / "public" / "fonts" / "PTBIPAPlus-Regular.ttf"


def _controls(trajectory):
    rows = trajectory.get("m27_50hz_pa")
    if rows is None or not len(rows):
        rows = trajectory.get("glottis_50hz_pa")
    if rows is not None and len(rows):
        values = np.asarray(rows, dtype=float)
        if values.ndim != 2 or values.shape[1] not in (10, 27):
            raise ValueError("无效的 M27 声门参数维数")
        times = np.arange(len(values)) / 50
        values = values[:, -len(FIELDS):]
    else:
        frames = trajectory.get("animation", {}).get("frames", [])
        frames = [frame for frame in frames if isinstance(frame, dict) and all(key in frame for key in FIELDS)]
        if not frames:
            raise ValueError("该条目没有可用的 M27 声门参数")
        times = np.asarray([frame["t"] for frame in frames], dtype=float)
        values = np.asarray([[frame[key] for key in FIELDS] for frame in frames], dtype=float)
    if not np.isfinite(times).all() or not np.isfinite(values).all() or np.any(np.diff(times) <= 0):
        raise ValueError("M27 声门轨迹的时刻或参数无效")
    return times, values


def _clamp(value, lo=0.0, hi=1.0):
    return min(hi, max(lo, value))


def _curve(points, count=14):
    control = np.asarray(points)
    t = np.linspace(0., 1., count)[:, None]
    if len(points) == 3:
        return ((1 - t) ** 2 * control[0] + 2 * t * (1 - t) * control[1] + t ** 2 * control[2]).tolist()
    return ((1 - t) ** 3 * control[0] + 3 * (1 - t) ** 2 * t * control[1]
            + 3 * (1 - t) * t ** 2 * control[2] + t ** 3 * control[3]).tolist()


def _top_view(draw, low, high, ca, length):
    # Medial edges and cartilage gap follow drawM27GlottisCanvas in tract-renderer.js.
    cx, cy, scale = 212, 235, 143
    ant, post = -.50 * length, .50 * length
    vp, mid = ant + .60 * length, ant + .31 * length
    membrane = min(low, high)
    cartilage = min(.29, membrane * 1.34 + ca * (.07 + .54 * _clamp(membrane / .03)))
    rear = min(.32, cartilage * .78 + ca * 1.32)
    center = _clamp(.54 * cartilage + membrane * .38, .0025, .31)
    front = _clamp(center * .08, .002, .012)
    band = .195 / sqrt(length)
    shape = _curve([(front, ant - .015), (center, mid), (cartilage, vp)])
    shape += _curve([(cartilage, vp), (cartilage + (rear - cartilage) * .46, vp + (post - vp) * .38),
                     (rear + .010, vp + (post - vp) * .76), (rear, post + .035)])[1:]
    draw.ellipse((cx - 118, cy - 124, cx + 118, cy + 124), fill="#945461", outline="#6d3c54", width=3)
    for sign in (-1, 1):
        inner = [(cx + sign * x * scale, cy + y * scale) for x, y in shape]
        outer = [(cx + sign * (x + band * (.47 + .48 * sin(pi * i / len(shape)))) * scale, cy + y * scale)
                 for i, (x, y) in enumerate(shape)]
        draw.polygon(inner + outer[::-1], fill="#f6d9d1")
        draw.line(inner, fill="#fdf2e8", width=3)
        draw.line(outer, fill="#ca9096", width=2)
        x, y = cx + sign * (rear + band * .7) * scale, cy + (post + .087) * scale
        draw.ellipse((x - 13, y - 11, x + 13, y + 11), fill="#dfaf9d")
    aperture = [(cx - x * scale, cy + y * scale) for x, y in shape]
    aperture += [(cx + x * scale, cy + y * scale) for x, y in reversed(shape)]
    draw.polygon(aperture, fill="#252238")


def _coronal_view(draw, low, high, ps, pressure):
    # Upper/lower edge gap and the phase-dependent mucosal wave use XB/XT and LAG.
    cx, top, h, radius = 552, 121, 231, 91
    upper, lower = top + h * .435, top + h * .655
    high_gap, low_gap = min(radius * .40, high * radius * 2.05), min(radius * .40, low * radius * 2.05)
    mid_gap = max(0., .5 * (high_gap + low_gap) + ps * 2.6)
    stations = [(radius * .50, top + h * .03), (max(radius * .25, high_gap + radius * .15), top + h * .195),
                (radius * .77, top + h * .275), (high_gap, upper), (mid_gap, (upper + lower) / 2),
                (low_gap, lower), (radius * .63, top + h * .955)]
    for sign in (-1, 1):
        wall = []
        for (x0, y0), (x1, y1) in zip(stations, stations[1:]):
            wall.extend(_curve([(cx + sign * x0,y0), (cx + sign * x0,y0 + (y1 - y0) / 3),
                                (cx + sign * x1,y1 - (y1 - y0) / 3), (cx + sign * x1,y1)])[:-1])
        wall.append((cx + sign * stations[-1][0], stations[-1][1]))
        outside_x = cx + sign * radius * 1.12
        draw.polygon([tuple(point) for point in wall] + [(outside_x, wall[-1][1]), (outside_x, wall[0][1])], fill="#9d5469")
        draw.line([tuple(point) for point in wall], fill="#f7c3b8", width=9)
    if pressure > 90:
        flow_y = top + h * .89
        flow_width = radius * _clamp(pressure / 1600) * .43 + radius * .1
        draw.rounded_rectangle((cx - flow_width, flow_y - 11, cx + flow_width, flow_y + 11), radius=8, fill="#346365")
        if min(high_gap, low_gap) > 1.0:
            draw.line((cx, lower + 52, cx, upper - 8), fill="#7ccac8", width=2)
            draw.line((cx - 5, upper - 2, cx, upper - 8, cx + 5, upper - 2), fill="#7ccac8", width=2)


def _frame(image, values, t, phase, hz, duration):
    f0, pressure, xb, xt, ca, lag, ra, ps, fl, shim = values
    active = pressure > 90 and ra > .05
    modulation = (1 + .10 * fl / 100 * sin(t * 31)) * (1 + .16 * shim / 100 * sin(phase * .5 + 1.1))
    amp = max(0., ra) * .115 * modulation if active else 0.
    low = max(0., xb + amp * sin(phase))
    high = max(0., xt + amp * sin(phase - lag) + .014 * ps * sin(2 * phase))
    length = _clamp(1 + .10 * (log(_clamp(f0, 60, 500)) - log(150)) / 1.45, .91, 1.09)
    frame = image.copy()
    draw = ImageDraw.Draw(frame)
    _top_view(draw, low, high, max(0., ca), length)
    _coronal_view(draw, low, high, ps, pressure)
    draw.text((30, 402), f"{t:0.3f} s  |  F0 {f0:.0f} Hz  |  Pressure {pressure:.0f} Pa  |  Display {hz:.1f} Hz",
              font=ImageFont.load_default(size=16), fill="#c1dde3")
    draw.rounded_rectangle((30, 433, 738, 437), radius=2, fill="#264958")
    draw.rounded_rectangle((30, 433, max(34, 30 + 708 * _clamp(t / duration)), 437), radius=2, fill="#7ccac8")
    return frame


def _canvas(entry):
    base = Image.new("RGB", (WIDTH, HEIGHT), "#132632")
    draw = ImageDraw.Draw(base)
    draw.rounded_rectangle((28, 94, 394, 378), 12, fill="#1b3543")
    draw.rounded_rectangle((404, 94, 740, 378), 12, fill="#1b3543")
    title = "M27  /  Vocal fold motion"
    symbol = entry.get("voqs_symbol") or str(entry.get("title", "")).partition(" · ")[0]
    font = ImageFont.truetype(str(IPA_FONT), 28) if IPA_FONT.is_file() else ImageFont.load_default(size=23)
    draw.text((30, 17), title, fill="#edf2f0", font=font)
    if symbol.strip() and draw.textlength(symbol, font=font) < 390:
        draw.text((737, 19), symbol, fill="#9ad6d0", font=font, anchor="ra")
    draw.text((30, 59), "Model simulation  /  Slowed vibration phase  /  Real-time source audio",
              fill="#afc4ca", font=ImageFont.load_default(size=16))
    draw.text((49, 103), "Superior view", fill="#a1c2c8", font=ImageFont.load_default(size=15))
    draw.text((424, 103), "Coronal view", fill="#a1c2c8", font=ImageFont.load_default(size=15))
    return base


def render_glottis_movie_file(entry, trajectory, wav_source, destination: Path) -> None:
    """Write H.264/AAC MP4 using the same WAV as the corresponding resource."""
    times, values = _controls(trajectory)
    info = sf.info(BytesIO(wav_source) if isinstance(wav_source, bytes) else wav_source)
    duration = info.frames / info.samplerate
    if duration <= 0:
        raise ValueError("声带视频需要实际录音")
    sample_times = np.arange(ceil(duration * FPS)) / FPS
    controls = np.column_stack([np.interp(sample_times, times, values[:, i]) for i in range(len(FIELDS))])
    f0 = controls[:, 0]
    hz = np.where(f0 > 40, 2.2 + 3.2 * np.clip((f0 - 60) / 340, 0, 1), 2.8)
    phase = np.r_[0., np.cumsum((hz[:-1] + hz[1:]) * pi / FPS)]
    ffmpeg = [os.environ.get("VOCALCUT_FFMPEG") or "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y"]
    base = _canvas(entry)
    with TemporaryDirectory(prefix="vocalcut-glottis-") as folder:
        wav = wav_source
        if isinstance(wav_source, bytes):
            wav = Path(folder) / "source.wav"
            wav.write_bytes(wav_source)
        cmd = ffmpeg + [
            "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{WIDTH}x{HEIGHT}", "-r", str(FPS), "-i", "pipe:0",
            "-i", str(wav), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "20",
            "-c:a", "aac", "-b:a", "160k", "-t", f"{duration:.9f}", "-movflags", "+faststart",
            "-metadata", "comment=M27 model simulation, slowed display phase; synchronized source audio", str(destination),
        ]
        with subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE) as encoder:
            try:
                for i, t in enumerate(sample_times):
                    encoder.stdin.write(_frame(base, controls[i], t, phase[i], hz[i], duration).tobytes())
            except BrokenPipeError:
                pass
            finally:
                encoder.stdin.close()
            error = encoder.stderr.read().decode("utf-8", "replace").strip()
            if encoder.wait() != 0:
                raise RuntimeError(f"声带 MP4 编码失败：{error}")


def render_glottis_movie(entry, trajectory, wav_bytes) -> bytes:
    with TemporaryDirectory(prefix="vocalcut-glottis-output-") as folder:
        output = Path(folder) / "folds.mp4"
        render_glottis_movie_file(entry, trajectory, wav_bytes, output)
        return output.read_bytes()
