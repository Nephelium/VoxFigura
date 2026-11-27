"""Encode the packaged copies of indexed IPA and VoQS source recordings."""
from concurrent.futures import ThreadPoolExecutor
from hashlib import file_digest
import json
from pathlib import Path
import re
import subprocess
import sys

import soundfile as sf


BITRATE_KBPS = 192


def _tag_crc(data: bytes) -> int:
    result = 0
    for byte in data:
        result ^= byte
        for _ in range(8):
            result = (result >> 1) ^ (0xA001 if result & 1 else 0)
    return result


def repair_mp3_tail(target: Path, extra_samples: int) -> None:
    """Correct the pinned FFmpeg muxer's gapless tail tag without rewriting audio frames."""
    # MPEG-1 Layer III side-info length is 17 B for mono (channel_mode == 3)
    # and 32 B for stereo / joint-stereo / dual-channel (channel_mode in {0, 1, 2}).
    # The Info/Xing tag starts right after the 4-byte frame header + side-info,
    # and stores the 24-bit (delay, padding) field at Info + 141 and CRC at Info + 154.
    if not 0 < extra_samples < 1152:
        raise RuntimeError(f"Unexpected gapless adjustment ({extra_samples}) in {target.name}")
    with target.open("r+b") as stream:
        frame_hdr = stream.read(4)
        if len(frame_hdr) != 4 or frame_hdr[:2] != b"\xff\xfb":
            raise RuntimeError(f"Unexpected MPEG-1 Layer III header in {target.name}")
        channel_mode = frame_hdr[3] >> 6
        side_info_len = 17 if channel_mode == 3 else 32
        info_offset = 4 + side_info_len
        tag_len = info_offset + 169  # 190 for mono, 205 for stereo
        padding_bytes = slice(info_offset + 141, info_offset + 144)
        checksum_bytes = slice(info_offset + 154, info_offset + 156)
        stream.seek(0)
        header = bytearray(stream.read(tag_len))
        tag_sig = header[info_offset : info_offset + 8]
        if len(header) != tag_len or tag_sig not in (b"Info\x00\x00\x00\x0f", b"Xing\x00\x00\x00\x0f"):
            raise RuntimeError(f"Unexpected gapless frame in {target.name}")
        checksum = int.from_bytes(header[checksum_bytes], "big")
        header[checksum_bytes] = b"\x00\x00"
        field = int.from_bytes(header[padding_bytes], "big")
        if _tag_crc(header) != checksum or (field & 0xFFF) + extra_samples > 0xFFF:
            raise RuntimeError(f"Cannot validate the encoder padding in {target.name}")
        header[padding_bytes] = (field + extra_samples).to_bytes(3, "big")
        header[checksum_bytes] = _tag_crc(header).to_bytes(2, "big")
        stream.seek(0)
        stream.write(header)


def encode_mp3(source: Path, target: Path, ffmpeg: Path, *, sample_rate: int | None = None) -> dict:
    original = sf.info(source)
    rate = sample_rate or original.samplerate
    expected_frames, remainder = divmod(original.frames * rate, original.samplerate)
    if remainder:
        raise ValueError(f"Requested sample rate does not preserve the duration of {source.name}")
    subprocess.run([str(ffmpeg), "-nostdin", "-hide_banner", "-loglevel", "error", "-n", "-i", str(source),
                    "-map", "0:a:0", "-map_metadata", "-1", "-id3v2_version", "0", "-ar", str(rate),
                    "-c:a", "libmp3lame", "-b:a", f"{BITRATE_KBPS}k", str(target)], check=True)
    encoded = sf.info(target)
    padding_adjustment = encoded.frames - expected_frames
    if padding_adjustment:
        repair_mp3_tail(target, padding_adjustment)
        encoded = sf.info(target)
    samples, decoded_rate = sf.read(target, dtype="float32", always_2d=True)
    if (encoded.format != "MP3" or decoded_rate != rate or
            samples.shape != (expected_frames, original.channels) or encoded.frames != expected_frames):
        raise RuntimeError(f"Encoder did not preserve the sample timeline for {source.name}")
    return {"sample_rate_hz": rate, "channels": original.channels, "sample_count": expected_frames,
            "bytes": target.stat().st_size,
            **({"gapless_padding_corrected_samples": padding_adjustment} if padding_adjustment else {})}


def encode(source_library: Path, stage: Path) -> None:
    output = stage / "engine/reference_library"
    ffmpeg = stage / "runtime/media/ffmpeg.exe"
    entries = json.loads((output / "index.json").read_text(encoding="utf-8"))
    originals = [entry for entry in entries if entry.get("exists")]
    for folder in ("recordings", "microphone"):
        (output / folder).mkdir(exist_ok=True)

    def convert(entry):
        identifier = entry["id"]
        if not re.fullmatch(r"[A-Za-z0-9_-]+", identifier):
            raise ValueError(f"Invalid reference ID: {identifier}")
        folder = "microphone" if entry.get("from_take") else "recordings"
        source = source_library / folder / f"{identifier}.wav"
        target = output / folder / f"{identifier}.mp3"
        if not source.is_file() or source.is_symlink() or not source.resolve().is_relative_to(source_library):
            raise ValueError(f"Invalid source recording: {source}")
        info = encode_mp3(source, target, ffmpeg)
        with source.open("rb") as stream:
            source_hash = file_digest(stream, "sha256").hexdigest()
        return {"id": identifier, "file": target.relative_to(output).as_posix(), "source_wav_sha256": source_hash,
                **info}

    with ThreadPoolExecutor(max_workers=8) as workers:
        records = list(workers.map(convert, originals))
    metadata = {"format": "MP3", "bitrate_kbps": BITRATE_KBPS, "recordings": records}
    (output / "media-encoding.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n",
                                                encoding="utf-8")
    print(f"Encoded and checked {len(records)} recordings at {BITRATE_KBPS} kbps", flush=True)


if __name__ == "__main__":
    encode(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve())
