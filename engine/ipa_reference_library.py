"""Read the user's local IPA exports and precomputed trajectories by indexed ID."""

import json
from pathlib import Path
import re
import threading


LIBRARY = Path(__file__).resolve().parent / "reference_library"
NEURAL_CACHE = Path(__file__).resolve().parents[1] / ".cache" / "ipa-neural-lite"
REFERENCE_ROUTE = re.compile(r"/models/ipa-references/([A-Za-z0-9_-]+)/(audio|animation|reconstruction|bundle|bundle-video)$")
_NEURAL_CACHE_LOCK = threading.Lock()


def index():
    path = LIBRARY / "index.json"
    if not path.is_file():
        return []
    records = json.loads(path.read_text(encoding="utf-8"))
    return [dict(record, has_textgrid=(LIBRARY / "textgrids" / f"{record['id']}.TextGrid").is_file(),
                 has_glottis=(LIBRARY / ("voqs" if record.get("voqs") else "") / f"{record['id']}.json").is_file() and not record["excluded"],
                 animation=not record.get("voqs") and (LIBRARY / f"{record['id']}.json").is_file()) for record in records]


def trill_audio_path(entry_id):
    path = LIBRARY / "trill-demos" / f"{entry_id}.mp3"
    return path if path.is_file() else path.with_suffix(".wav")


def _trill_fallback_paths(entry_id):
    audio = trill_audio_path(entry_id)
    track = LIBRARY / "trill-demos" / f"{entry_id}.json"
    return (audio if audio.is_file() else None), (track if track.is_file() else None)


def _trill_fallback_meta(track_path):
    if track_path is None or not track_path.is_file():
        return {}
    try:
        data = json.loads(track_path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    meta = {}
    if isinstance(data.get("duration_s"), (int, float)):
        meta["duration_s"] = float(data["duration_s"])
    elif isinstance(data.get("animation"), dict) and isinstance(data["animation"].get("duration_sec"), (int, float)):
        meta["duration_s"] = float(data["animation"]["duration_sec"])
    if isinstance(data.get("phones"), list):
        meta["phones"] = data["phones"]
    return meta


def playback_index():
    from ipa_materials import material_times

    items = []
    for entry in index():
        if entry.get("exists"):
            items.append(dict(entry, **material_times(entry, LIBRARY, recording_path(entry))))
            continue
        wav, track = _trill_fallback_paths(entry["id"])
        if wav is not None:
            items.append(
                dict(
                    entry,
                    exists=True,
                    animation=track is not None,
                    synthesized_trill=True,
                    **_trill_fallback_meta(track),
                )
            )
        else:
            items.append(dict(entry))
    return items

def poses():
    path = LIBRARY / "poses.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else []


def vowel_formants():
    path = LIBRARY / "vowel-formants.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {"records": []}


def playback_measurements(content):
    """Expose acoustic provenance relative to playback while retaining its source interval."""
    from ipa_materials import material_times

    by_id = {entry["id"]: entry for entry in index()}
    records = []
    for point in content.get("records", []):
        entry = by_id.get(point["id"])
        timing = material_times(entry, LIBRARY, recording_path(entry)) if entry else {}
        if "trim_start_s" not in timing:
            records.append(point)
            continue
        start, end = point["core_start_s"], point["core_end_s"]
        offset = timing["trim_start_s"]
        records.append({
            **point, "source_core_start_s": start, "source_core_end_s": end,
            "core_start_s": round(max(0.0, start - offset), 6),
            "core_end_s": round(min(timing["duration_s"], end - offset), 6),
        })
    return {**content, "records": records}


def trill_demos():
    path = LIBRARY / "trill-demos" / "index.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else []


def recording_path(entry):
    wav = LIBRARY / ("microphone" if entry.get("from_take") else "recordings") / f"{entry['id']}.wav"
    mp3 = wav.with_suffix(".mp3")
    return wav if wav.is_file() or not mp3.is_file() else mp3


def reconstruction_audio(entry, bridge):
    controls = LIBRARY / f"{entry['id']}.json"
    speaker = recording_path(entry)
    if entry.get("voqs") or not entry["animation"] or not controls.is_file() or not speaker.is_file():
        return None
    cache = NEURAL_CACHE / f"{entry['id']}-peak.wav"
    with _NEURAL_CACHE_LOCK:
        freshness = max(controls.stat().st_mtime_ns, speaker.stat().st_mtime_ns)
        if not cache.is_file() or cache.stat().st_mtime_ns < freshness:
            rows = json.loads(controls.read_text(encoding="utf-8"))["m27_50hz_pa"]
            audio = bridge.neural_reference_audio(rows, speaker)
            cache.parent.mkdir(parents=True, exist_ok=True)
            tmp = cache.with_suffix(".tmp")
            tmp.write_bytes(audio)
            tmp.replace(cache)
    return cache.read_bytes(), "audio/wav"


def load_resource(reference_id, resource, bridge=None, *, audio_gain="peak"):
    from ipa_materials import material_zip, prepare_materials, scale_wav_bytes

    is_trill_demo = any(demo["id"] == reference_id for demo in trill_demos())
    raw_entry = next((item for item in index() if item["id"] == reference_id), None)
    if is_trill_demo or (raw_entry is not None and not raw_entry.get("exists")):
        fb_wav, fb_track = _trill_fallback_paths(reference_id)
        if resource in ("audio", "reconstruction") and fb_wav is not None:
            if resource == "reconstruction" and bridge is not None and fb_track is not None:
                ref_spk = recording_path({"id": "main-T061"})
                if ref_spk.is_file():
                    try:
                        rows = json.loads(fb_track.read_text(encoding="utf-8")).get("m27_50hz_pa")
                        if rows:
                            cache = NEURAL_CACHE / f"{reference_id}-trill-peak.wav"
                            with _NEURAL_CACHE_LOCK:
                                freshness = max(fb_track.stat().st_mtime_ns, ref_spk.stat().st_mtime_ns)
                                if not cache.is_file() or cache.stat().st_mtime_ns < freshness:
                                    audio = bridge.neural_reference_audio(rows, ref_spk)
                                    cache.parent.mkdir(parents=True, exist_ok=True)
                                    tmp = cache.with_suffix(".tmp")
                                    tmp.write_bytes(audio)
                                    tmp.replace(cache)
                            return scale_wav_bytes(cache, audio_gain=audio_gain), "audio/wav"
                    except Exception:
                        pass
            return scale_wav_bytes(fb_wav, audio_gain=audio_gain), "audio/wav"
        if resource == "animation" and fb_track is not None:
            return fb_track.read_bytes(), "application/json; charset=utf-8"
        if is_trill_demo:
            return None
    entry = raw_entry if (raw_entry is not None and raw_entry.get("exists")) else None
    if not entry:
        return None
    wave = recording_path(entry)
    if not wave.is_file():
        return None
    if resource in ("bundle", "bundle-video"):
        rebuilt = reconstruction_audio(entry, bridge) if entry["animation"] and not entry["excluded"] else None
        return material_zip(
            entry, LIBRARY, wave, rebuilt[0] if rebuilt else None, resource == "bundle-video", audio_gain=audio_gain,
        )

    if resource == "reconstruction":
        rebuilt = reconstruction_audio(entry, bridge)
        if rebuilt is None:
            return None
        _, _, _, data = prepare_materials(entry, LIBRARY, wave, rebuilt[0], audio_gain=audio_gain)
        mime = "audio/wav"
    elif resource == "animation":
        if not entry["animation"]:
            return None
        _, _, data, _ = prepare_materials(entry, LIBRARY, wave, audio_gain="original")
        mime = "application/json; charset=utf-8"
    else:
        data, _, _, _ = prepare_materials(entry, LIBRARY, wave, audio_gain=audio_gain)
        mime = "audio/wav"
    return (data.read_bytes() if isinstance(data, Path) else data, mime) if data is not None else None
