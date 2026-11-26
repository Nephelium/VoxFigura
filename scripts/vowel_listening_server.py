"""Serve the local two-vowel listening page and measure recordings in memory."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
import json
import math
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import numpy as np
import parselmouth
import soundfile as sf

from measure_ipa_vowel_formants import measure_sound


SCRIPT_DIR = Path(__file__).resolve().parent
PAGE_DIR = SCRIPT_DIR / "vowel-listening"
REFERENCES = SCRIPT_DIR.parent / "engine" / "reference_library" / "vowel-formants.json"
ASSETS = {
    "/": (PAGE_DIR / "index.html", "text/html"),
    "/app.js": (PAGE_DIR / "app.js", "text/javascript"),
    "/microphone.js": (PAGE_DIR / "microphone.js", "text/javascript"),
    "/microphone-worklet.js": (PAGE_DIR / "microphone-worklet.js", "text/javascript"),
    "/style.css": (PAGE_DIR / "style.css", "text/css"),
    "/recording-silence.js": (SCRIPT_DIR.parent / "src" / "data" / "recording-silence.js", "text/javascript"),
    "/references": (REFERENCES, "application/json"),
}
MAX_BYTES = 20 * 1024 * 1024
MAX_SECONDS = 30


def recording_interval(samples, sample_rate):
    """Trim quiet leading and trailing blocks before applying the central 40% rule."""
    hop = max(1, round(sample_rate * .01))
    block_count = len(samples) // hop
    rms = np.sqrt(np.mean(samples[:block_count * hop].reshape(block_count, hop) ** 2, axis=1))
    active = np.flatnonzero(rms > max(.0001, .1 * float(np.quantile(rms, .95))))
    if active.size < 5:
        return 0.0, len(samples) / sample_rate
    return int(active[0]) * hop / sample_rate, (int(active[-1]) + 1) * hop / sample_rate


def analyze(audio, query):
    with sf.SoundFile(BytesIO(audio)) as file:
        if not 8000 <= file.samplerate <= 192000 or not 1 <= file.channels <= 8:
            raise ValueError("需要 8–192 kHz、1–8 声道的录音。")
        sample_rate = file.samplerate
        duration = file.frames / sample_rate
        if not .08 <= duration <= MAX_SECONDS:
            raise ValueError("请选用 0.08–30 秒的录音。")
        samples = file.read(dtype="float64", always_2d=True).mean(axis=1)
    if not np.isfinite(samples).all():
        raise ValueError("录音包含无效采样值。")
    if query:
        try:
            start, end = float(query["start_s"][0]), float(query["end_s"][0])
        except (KeyError, ValueError) as error:
            raise ValueError("请填写测量起点和终点。") from error
        if not (math.isfinite(start) and math.isfinite(end) and 0 <= start < end <= duration + 1e-6
                and end - start >= .08):
            raise ValueError("测量区间须在录音内，且至少 0.08 秒。")
    else:
        start, end = recording_interval(samples, sample_rate)
    sound = parselmouth.Sound(samples, sampling_frequency=sample_rate)
    return {
        "duration_s": round(duration, 6),
        "start_s": round(start, 6),
        "end_s": round(end, 6),
        "measurement": measure_sound(sound, start, end),
    }


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        self.request.settimeout(15)
        super().setup()

    def send_data(self, status, media_type, data):
        self.send_response(status)
        self.send_header("Content-Type", f"{media_type}; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, status, data):
        self.send_data(status, "application/json", json.dumps(data, ensure_ascii=False).encode("utf-8"))

    def do_GET(self):
        asset = ASSETS.get(urlsplit(self.path).path)
        if asset is None:
            return self.send_json(404, {"error": "页面不存在。"})
        path, media_type = asset
        self.send_data(200, media_type, path.read_bytes())

    def do_POST(self):
        url = urlsplit(self.path)
        if url.path != "/measure":
            return self.send_json(404, {"error": "接口不存在。"})
        origin = f"http://127.0.0.1:{self.server.server_port}"
        if self.headers.get("Origin", origin) != origin:
            return self.send_json(403, {"error": "请从本机测试页提交录音。"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_BYTES:
                return self.send_json(413, {"error": "单条录音上限为 20 MB。"})
            data = analyze(self.rfile.read(length), parse_qs(url.query, max_num_fields=4))
        except (sf.LibsndfileError, parselmouth.PraatError, EOFError):
            return self.send_json(422, {"error": "无法分析这条录音，请检查文件或转成 PCM WAV。"})
        except ValueError as error:
            return self.send_json(422, {"error": str(error)})
        self.send_json(200, data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8772)
    args = parser.parse_args()
    with ThreadingHTTPServer(("127.0.0.1", args.port), Handler) as server:
        print(f"http://127.0.0.1:{server.server_port}/", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
